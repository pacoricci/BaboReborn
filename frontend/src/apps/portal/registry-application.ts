import { createMutation, createQuery } from '@tanstack/solid-query';
import type { QueryClient } from '@tanstack/solid-query';
import { createSignal, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import { registryAPI } from './registry-api';
import type { Server } from './registry-api';

const REFRESH_MS = 15_000;

export type RegistryPanel =
  | { kind: 'register'; title: string; description: string }
  | { kind: 'settings' | 'setup' | 'transfer'; title: string; description?: string; server: Server }
  | { kind: 'confirm'; title: string; description: string; label: string; action(): Promise<void> };
interface Pairing {
  code: string;
  expiresAt: string;
}
interface Registration {
  server: Server;
  code?: string;
  expiresAt?: string;
}

// The page owns polling and writes; each keyed dialog owns its detached draft.
export function createRegistry(
  account: () => string,
  client: QueryClient,
  confirmAction: (message: string) => boolean,
) {
  const servers = createQuery(
    () => ({
      queryKey: ['registry', account()],
      queryFn: ({ signal }) =>
        registryAPI<Server[]>('/api/v1/manage/servers', 'GET', undefined, signal),
      refetchInterval: REFRESH_MS,
      reconcile: 'id',
    }),
    () => client,
  );
  const mutation = createMutation(
    () => ({ mutationFn: (action: () => Promise<void>) => action() }),
    () => client,
  );
  const [notice, setNotice] = createSignal('');
  const [panel, setPanel] = createSignal<RegistryPanel>();
  const [dirty, setDirty] = createSignal(false);
  const [codes, setCodes] = createStore<Record<string, Pairing>>({});
  let writing = false;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const items = () => servers.data ?? [];
  const discard = () => !dirty() || confirmAction('Discard your unsaved changes?');
  function open(value: RegistryPanel) {
    if (!discard()) return;
    setDirty(false);
    setPanel(value);
  }
  function close() {
    if (writing || mutation.isPending || !discard()) return;
    setDirty(false);
    setPanel(undefined);
  }
  async function refreshAfterWrite() {
    if (disposed) return;
    // Cancel any older read so a successful write cannot be followed by its stale result.
    await client.cancelQueries({ queryKey: ['registry'] });
    const result = await servers.refetch();
    if (result.isError) setNotice('Change saved. The list could not refresh; retry Refresh.');
  }
  function mutate(server: Server, action: string, extra: Record<string, unknown> = {}) {
    return registryAPI<Registration>(`/api/v1/manage/servers/${server.id}/${action}`, 'POST', {
      revision: server.revision,
      ...extra,
    });
  }
  function setup(server: Server) {
    open({
      kind: 'setup',
      title: `Connect ${server.name}`,
      description: 'Run your community server, then return here to check its status.',
      server,
    });
  }
  function showCode(result: Registration) {
    if (disposed) return;
    if (!result.code || !result.expiresAt || !Number.isFinite(Date.parse(result.expiresAt)))
      throw new Error('Invalid pairing code response.');
    setCodes(result.server.id, { code: result.code, expiresAt: result.expiresAt });
    setDirty(false);
    setup(result.server);
  }
  function confirm(
    server: Server,
    label: string,
    description: string,
    action: () => Promise<void>,
  ) {
    open({ kind: 'confirm', title: `${label} · ${server.name}`, label, description, action });
  }
  async function finish(message: string) {
    if (disposed) return;
    setDirty(false);
    setPanel(undefined);
    setNotice(message);
    await refreshAfterWrite();
  }
  function settings(server: Server) {
    // The editor owns a detached revision; live list refreshes never replace its draft.
    open({ kind: 'settings', title: `Settings · ${server.name}`, server: { ...server } });
  }
  function createForm(value: RegistryPanel) {
    const initial = 'server' in value ? value.server : undefined;
    const [server, setServer] = createSignal(initial);
    const [draft, setDraft] = createStore({
      name: initial?.name ?? '',
      region: initial?.region ?? '',
      origin: initial?.origin ?? '',
      account: '',
    });
    const [feedback, setFeedback] = createSignal('');
    const [failed, setFailed] = createSignal(false);
    const saved = () => (initial ? codes[initial.id] : undefined);
    const current = () => items().find((item) => item.id === initial?.id) ?? initial!;
    const expired = () =>
      !!saved() && Date.parse(saved()!.expiresAt) <= Math.max(servers.dataUpdatedAt, Date.now());
    async function action() {
      switch (value.kind) {
        case 'register':
          showCode(
            await registryAPI<Registration>('/api/v1/manage/servers', 'POST', {
              name: draft.name.trim(),
              region: draft.region.trim(),
              origin: draft.origin.trim(),
            }),
          );
          await refreshAfterWrite();
          break;
        case 'settings': {
          const result = await registryAPI<{ server: Server }>(
            `/api/v1/manage/servers/${server()!.id}`,
            'PATCH',
            {
              name: draft.name.trim(),
              region: draft.region.trim(),
              origin: draft.origin.trim(),
              revision: server()!.revision,
            },
          );
          setServer({ ...server()!, ...result.server });
          setDirty(false);
          setNotice(`Details saved for ${draft.name.trim()}.`);
          await refreshAfterWrite();
          setFeedback('Details saved.');
          break;
        }
        case 'setup':
          if (
            saved() &&
            Date.parse(saved()!.expiresAt) > Date.now() &&
            !confirmAction('Replace the current pairing code? It will stop working.')
          ) {
            setFeedback('');
            return;
          }
          showCode(await mutate(current(), 'code'));
          await refreshAfterWrite();
          break;
        case 'transfer': {
          const target = draft.account;
          setDirty(false);
          confirm(
            server()!,
            'Offer ownership transfer',
            `New owner: ${target}. After acceptance you will lose owner access to this server. The offer expires after 24 hours.`,
            async () => {
              await mutate(server()!, 'transfer', { account: target });
              await finish(`Ownership transfer offered for ${server()!.name}.`);
            },
          );
          break;
        }
        case 'confirm':
          await value.action();
      }
    }
    function submit() {
      if (writing || mutation.isPending) return;
      writing = true;
      setFeedback('Saving…');
      setFailed(false);
      return mutation
        .mutateAsync(action)
        .catch((error) => {
          setFeedback(
            error instanceof Error ? error.message : 'Unable to connect. Retry in a moment.',
          );
          setFailed(true);
        })
        .finally(() => {
          writing = false;
        });
    }
    function recover() {
      if (!server()!.publicKey) {
        setup(server()!);
        return;
      }
      confirm(
        server()!,
        'Recover installation',
        'Create a private code for a replacement installation. The current installation remains active until the replacement is associated.',
        async () => {
          showCode(await mutate(server()!, 'recover'));
          await refreshAfterWrite();
        },
      );
    }
    function transfer() {
      open({
        kind: 'transfer',
        title: `Transfer ${server()!.name}`,
        description:
          'Ask the recipient to copy their Account ID from Account → Account ID. They must accept the offer; then the server must confirm the new owner.',
        server: server()!,
      });
    }
    function cancelTransfer() {
      confirm(server()!, 'Cancel transfer', 'Cancel the pending ownership offer?', async () => {
        await mutate(server()!, 'cancel-transfer');
        await finish('Ownership transfer cancelled.');
      });
    }
    function remove() {
      confirm(
        server()!,
        'Remove registration',
        'Remove this server from the portal and disconnect its players. Local room definitions and data remain on the host.',
        async () => {
          await registryAPI(`/api/v1/manage/servers/${server()!.id}`, 'DELETE');
          await finish(`${server()!.name} removed from the portal.`);
        },
      );
    }
    return {
      server,
      draft,
      setDraft,
      feedback,
      setFeedback,
      failed,
      saved,
      current,
      expired,
      submit,
      recover,
      transfer,
      cancelTransfer,
      remove,
      changed: () => {
        setDirty(true);
        setFeedback('');
      },
    };
  }
  function register() {
    open({
      kind: 'register',
      title: 'Register a server',
      description:
        'Register an existing installation. You will need a public HTTPS address and access to the host.',
    });
  }
  function accept(server: Server) {
    confirm(
      { ...server },
      'Accept ownership',
      'Accept ownership of this server? The change completes when the installation confirms it.',
      async () => {
        await mutate(server, 'accept');
        await finish('Transfer accepted. Waiting for the server to confirm.');
      },
    );
  }
  function decline(server: Server) {
    confirm({ ...server }, 'Decline transfer', 'Decline this ownership offer?', async () => {
      await mutate(server, 'reject');
      await finish('Transfer declined.');
    });
  }
  return {
    servers,
    items,
    notice,
    panel,
    dirty,
    close,
    setup,
    settings,
    register,
    accept,
    decline,
    createForm,
    busy: () => mutation.isPending,
    refresh() {
      setNotice('');
      return servers.refetch();
    },
  };
}
