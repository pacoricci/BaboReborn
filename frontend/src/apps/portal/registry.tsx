import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { createPageQueries } from '../../bootstrap/queries';
import { Dialog } from '../../ui/dialog';
import { registryErrors, serverState, releaseSummary } from './registry-api';
import type { Server } from './registry-api';
import { createRegistry } from './registry-application';
import type { RegistryPanel } from './registry-application';

function Registry(props: { account: string }) {
  const app = createRegistry(
    () => props.account,
    createPageQueries(),
    (message) => window.confirm(message),
  );
  const { servers, items, notice, panel, close, setup, settings } = app;
  const [search, setSearch] = createSignal('');
  const visible = (server: Server) =>
    `${server.name} ${server.region}`.toLowerCase().includes(search().trim().toLowerCase());
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (app.dirty()) event.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);
  onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));
  function PanelForm(p: { value: RegistryPanel }) {
    const value = p.value;
    const initial = 'server' in value ? value.server : undefined;
    const form = app.createForm(value);
    const { server, draft, setDraft, feedback, setFeedback, failed, saved, current, expired } =
      form;
    let heading!: HTMLHeadingElement;
    let firstInput: HTMLInputElement | undefined;
    onMount(() => (firstInput ?? heading).focus());
    const fields = value.kind === 'register' || value.kind === 'settings';
    const label = () =>
      value.kind === 'register'
        ? 'Register a server'
        : value.kind === 'settings'
          ? 'Save details'
          : value.kind === 'transfer'
            ? 'Review transfer'
            : value.kind === 'setup'
              ? 'Generate new code'
              : value.kind === 'confirm'
                ? value.label
                : '';
    function download() {
      const url = URL.createObjectURL(new Blob([saved()!.code], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `baboreborn-${initial!.id}.pairing`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function Field(field: {
      name: keyof typeof draft;
      label: string;
      max: number;
      placeholder?: string;
    }) {
      return (
        <label>
          {field.label}
          <input
            ref={(element) => {
              if (field.name === 'name' || field.name === 'account') firstInput = element;
            }}
            name={field.name}
            type={field.name === 'origin' ? 'url' : 'text'}
            required
            maxlength={field.max}
            placeholder={field.placeholder}
            pattern={field.name === 'account' ? '[a-f0-9]{32}' : undefined}
            minlength={field.name === 'account' ? 32 : undefined}
            value={draft[field.name]}
            onInput={(e) => setDraft(field.name, e.currentTarget.value)}
            disabled={app.busy()}
          />
        </label>
      );
    }
    return (
      <>
        <h2
          id="registry-dialog-title"
          tabindex="-1"
          ref={(element) => {
            heading = element;
          }}
        >
          {value.title}
        </h2>
        <Show when={value.description}>
          <p class="muted">{value.description}</p>
        </Show>
        <form
          class="management-form"
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit();
          }}
          onInput={form.changed}
        >
          <Show when={fields}>
            <Field name="name" label="Name" max={100} />
            <Field name="region" label="Region" max={80} placeholder="Europe" />
            <Field
              name="origin"
              label="Public address"
              max={2048}
              placeholder="https://game.example.org"
            />
            <Show when={value.kind === 'settings'}>
              <p class="muted">A new address must pass verification before it is published.</p>
            </Show>
          </Show>
          <Show when={value.kind === 'transfer'}>
            <Field name="account" label="New owner account ID" max={32} />
          </Show>
          <Show when={value.kind === 'setup'}>
            <p class="mono">{initial?.origin}</p>
            <ol class="setup-steps">
              <li>
                Install the BaboReborn community server on a host reachable at its public address.
              </li>
              <li>
                {saved()
                  ? `Save the private pairing code below to a file. It expires at ${new Date(saved()!.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                  : 'Generate a new pairing code to connect this installation.'}
              </li>
            </ol>
            <Show when={saved()}>
              {(pairing) => (
                <>
                  <code class="pairing-code">{pairing().code}</code>
                  <div class="inline-actions">
                    <button
                      type="button"
                      disabled={app.busy()}
                      onClick={() =>
                        void navigator.clipboard.writeText(pairing().code).then(
                          () => setFeedback('Code copied.'),
                          () => setFeedback('Select and copy the code above.'),
                        )
                      }
                    >
                      Copy code
                    </button>
                    <button type="button" disabled={app.busy()} onClick={download}>
                      Download code file
                    </button>
                  </div>
                  <p class="muted">Start the server with your saved code file:</p>
                  <code class="setup-command">{`./server -central ${location.origin} -pairing-code-file ./baboreborn-${initial!.id}.pairing`}</code>
                  <p class="muted">
                    After association, the server appears Online. Creating a room makes it available
                    in Rooms.
                  </p>
                </>
              )}
            </Show>
            <p class="feedback" role="status">
              {current().online
                ? 'Connected. Your server is ready to manage.'
                : expired()
                  ? 'This code expired. Generate a new code to continue.'
                  : `${serverState(current())}. This status updates automatically.`}
            </p>
          </Show>
          <p classList={{ feedback: true, error: failed() }} role="status">
            {feedback()}
          </p>
          <div class="dialog-actions">
            <button
              type="button"
              class={value.kind === 'setup' ? 'primary' : ''}
              disabled={app.busy()}
              onClick={close}
            >
              {value.kind === 'setup' ? 'Done' : 'Cancel'}
            </button>
            <button
              type="submit"
              class={value.kind === 'setup' ? '' : 'primary'}
              hidden={value.kind === 'setup' && current().online}
              disabled={app.busy()}
            >
              {label()}
            </button>
            <Show when={value.kind === 'setup' && current().online}>
              <a class="primary button" href={`/manage/servers/${initial!.id}`}>
                Manage rooms and access
              </a>
            </Show>
          </div>
        </form>
        <Show when={value.kind === 'settings'}>
          <details class="maintenance">
            <summary>Installation &amp; ownership</summary>
            <p class="muted">Use recovery only when replacing or restoring this installation.</p>
            <button type="button" disabled={app.busy()} onClick={form.recover}>
              {server()?.publicKey ? 'Recover installation' : 'Connect installation'}
            </button>
            <Show
              when={server()?.transferTo}
              fallback={
                <Show when={server()?.publicKey}>
                  <button type="button" disabled={app.busy()} onClick={form.transfer}>
                    Transfer ownership
                  </button>
                </Show>
              }
            >
              <p class="mono">Transfer offered to {server()?.transferTo}</p>
              <button type="button" disabled={app.busy()} onClick={form.cancelTransfer}>
                Cancel transfer
              </button>
            </Show>
            <button type="button" class="danger" disabled={app.busy()} onClick={form.remove}>
              Remove registration
            </button>
          </details>
        </Show>
      </>
    );
  }
  return (
    <>
      <div class="management-heading">
        <div>
          <h1>Manage servers</h1>
        </div>
        <button id="register-open" class="primary" type="button" onClick={app.register}>
          Register a server
        </button>
      </div>
      <div class="management-toolbar">
        <label>
          Find a server
          <input
            id="server-search"
            type="search"
            placeholder="Name or region"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
        </label>
        <p id="server-count" class="muted">
          {items().length} servers · {items().filter((server) => server.online).length} online
        </p>
        <button id="registry-refresh" type="button" onClick={() => void app.refresh()}>
          Refresh
        </button>
      </div>
      <p
        id="registry-status"
        classList={{ feedback: true, error: servers.isError && !notice() }}
        role="status"
      >
        {notice() || servers.error?.message}
      </p>
      <div id="owned-servers" aria-label="Your servers">
        <For each={items()}>
          {(server) => {
            const owner = () => server.owner === props.account;
            const offer = () =>
              !owner() && server.transferTo === props.account && !server.transferAccepted;
            const detail = () =>
              server.error &&
              !(server.error === 'incompatible_server' && server.release?.differences.length)
                ? (registryErrors[server.error] ?? server.error.replaceAll('_', ' '))
                : server.candidateOrigin
                  ? `Verifying ${server.candidateOrigin}. The current address stays active.`
                  : server.publicKey && server.revision !== server.appliedRevision
                    ? 'Waiting for this installation to acknowledge the change.'
                    : !server.online && server.publicKey && !server.release?.differences.length
                      ? 'Check that the host is running and reachable at its public address.'
                      : server.transferTo
                        ? `Ownership transfer ${server.transferAccepted ? 'accepted; awaiting server confirmation' : 'pending acceptance'}.`
                        : '';
            return (
              <section
                class="account-card server-row"
                data-server-id={server.id}
                hidden={!visible(server)}
              >
                <div class="server-identity">
                  <h2>{server.name}</h2>
                  <p class="muted">
                    {server.region} · {server.role || 'Transfer recipient'} · {server.origin}
                  </p>
                </div>
                <span class="state-badge" data-online={String(server.online)}>
                  {serverState(server)}
                </span>
                <div class="inline-actions">
                  <a
                    class="primary button"
                    href={`/manage/servers/${server.id}`}
                    hidden={!server.online || !server.role}
                  >
                    Manage rooms and access
                  </a>
                  <button
                    type="button"
                    hidden={!owner() || !!server.publicKey}
                    onClick={() => setup({ ...server })}
                  >
                    Connect installation
                  </button>
                  <button type="button" hidden={!owner()} onClick={() => settings(server)}>
                    Settings
                  </button>
                  <button type="button" hidden={!offer()} onClick={() => app.accept(server)}>
                    Review transfer
                  </button>
                  <button type="button" hidden={!offer()} onClick={() => app.decline(server)}>
                    Decline
                  </button>
                </div>
                <Show when={server.publicKey ? server.release : undefined}>
                  {(release) => (
                    <div class="server-detail muted">
                      <p>{releaseSummary(release())}</p>
                      <Show
                        when={
                          release().notesUrl &&
                          (release().status === 'update_available' ||
                            release().status === 'update_required' ||
                            release().status === 'incompatible')
                        }
                      >
                        <a href={release().notesUrl} target="_blank" rel="noreferrer">
                          Release notes
                        </a>
                      </Show>
                      <Show when={release().differences.length}>
                        <details>
                          <summary>Compatibility details</summary>
                          <For each={release().differences}>
                            {(difference) => (
                              <p>
                                {difference.contract}: expected {difference.expected}, received{' '}
                                {difference.received}
                              </p>
                            )}
                          </For>
                        </details>
                      </Show>
                    </div>
                  )}
                </Show>
                <p class="server-detail muted" hidden={!detail()}>
                  {detail()}
                </p>
              </section>
            );
          }}
        </For>
      </div>
      <p id="servers-empty" class="empty-state" hidden={items().some(visible)}>
        {items().length
          ? 'No servers match your search.'
          : 'No servers yet. Register an installation, or ask its owner to grant you staff access using your Account ID.'}
      </p>
      <Show when={!!panel()}>
        <Dialog
          id="registry-dialog"
          labelledBy="registry-dialog-title"
          fallbackFocus="register-open"
          cancel={close}
        >
          <Show when={panel()} keyed>
            {(value) => <PanelForm value={value} />}
          </Show>
        </Dialog>
      </Show>
    </>
  );
}
const root = document.getElementById('registry');
if (root) {
  const unmount = render(() => <Registry account={root.dataset.account!} />, root);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) unmount();
  });
}
