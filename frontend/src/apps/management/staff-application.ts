import { createQuery, createMutation, isCancelledError } from '@tanstack/solid-query';
import type { QueryClient } from '@tanstack/solid-query';
import { createComputed, createSignal, on, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import { roomRulesChanged, validateRoom } from './rules';
import type { ManagementContext } from './application';
import type { RoomConfig, ServerIdentity, Restriction } from '../../contracts/server';
import { managesRooms, moderates, REFRESH_INTERVAL_MS } from './application';

export interface Person {
  subject: string;
  nickname: string;
  nicknameColors?: string | undefined;
  room: string;
}
export interface StaffRole {
  account: string;
  role: string;
}
export interface Audit {
  id: number;
  actor: string;
  target: string;
  action: string;
  reason: string;
  createdAt: string;
  details?: {
    id?: string;
    expiresAt?: string | null;
    name?: string;
    previous?: string;
    role?: string;
  };
}
export interface Operation {
  id: string;
  status: string;
  error?: string;
  deadlineAt: string;
}
export interface StaffData {
  people: Person[];
  restrictions: Restriction[];
  events: Audit[];
  roles: StaffRole[];
}
export interface RoomEditor {
  id: string;
  config: RoomConfig;
}
export interface StaffPorts {
  load(manage: boolean, signal: AbortSignal): Promise<StaffData>;
  room(id: string, signal: AbortSignal): Promise<RoomConfig>;
  saveRoom(id: string, config: RoomConfig): Promise<Operation | null>;
  renameRoom(id: string, name: string): Promise<void>;
  closeRoom(id: string): Promise<Operation>;
  kick(target: string): Promise<void>;
  ban(target: string, minutes: number, reason: string): Promise<void>;
  saveRole(account: string, role: string): Promise<void>;
  revoke(id: string): Promise<void>;
  operation(id: string, signal: AbortSignal): Promise<Operation>;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/** The page owns mutations/polling; hiding Staff cancels only transient reads and editors. */
export type StaffApplication = ReturnType<typeof createStaff>;
export function createStaff(rooms: ManagementContext, ports: StaffPorts, client: QueryClient) {
  const lifetime = new AbortController();
  const [active, setActive] = createSignal(false);
  const query = createQuery(
    () => ({
      queryKey: ['staff', rooms.state.data?.identity.subject, rooms.state.data?.identity.role],
      queryFn: ({ signal }) => ports.load(canManage(), signal),
      enabled: active() && canModerate() && !rooms.state.error,
      refetchInterval: REFRESH_INTERVAL_MS,
    }),
    () => client,
  );
  const mutation = createMutation(
    () => ({ mutationFn: (action: () => Promise<void>) => action() }),
    () => client,
  );
  let writing = false;
  const roomOperations: Record<string, { pending: boolean; message: string; error: string }> = {};
  const [state, setState] = createStore({
    message: '',
    error: '',
    editor: null as RoomEditor | null,
    editorLoading: false,
    roomOperations,
    get rooms() {
      return rooms.state.data;
    },
    get data() {
      return canModerate() ? (query.data ?? null) : null;
    },
    get loading() {
      return query.isFetching;
    },
    get busy() {
      return mutation.isPending;
    },
    get accessBlocked() {
      return !rooms.state.data || !!rooms.state.error;
    },
    get loadError() {
      return query.error?.message ?? '';
    },
  });
  function update(
    patch: Partial<
      Pick<typeof state, 'message' | 'error' | 'editor' | 'editorLoading' | 'roomOperations'>
    >,
  ) {
    if (!lifetime.signal.aborted) setState(patch);
  }
  createComputed(
    on(
      () => [
        rooms.state.data?.identity.subject,
        rooms.state.data?.identity.role,
        rooms.state.data?.identity.expired,
      ],
      (value, previous) => {
        if (!canManage() || (previous && previous[0] !== value[0])) closeEditor();
      },
    ),
  );
  onCleanup(dispose);
  function identity(): ServerIdentity | undefined {
    return rooms.state.data?.identity;
  }
  function canManage(): boolean {
    const current = identity();
    return !!current && managesRooms(current);
  }
  function canModerate(): boolean {
    const current = identity();
    return !!current && moderates(current);
  }
  function activate(value: boolean): void {
    if (lifetime.signal.aborted || value === active()) return;
    setActive(value);
    if (!value) {
      void client.cancelQueries({ queryKey: ['staff'] });
      closeEditor();
    }
  }
  async function refresh(): Promise<void> {
    if (!active() || !canModerate() || lifetime.signal.aborted) return;
    await client.cancelQueries({ queryKey: ['staff'] });
    await query.refetch();
  }
  function closeEditor(): void {
    void client.cancelQueries({ queryKey: ['room-editor'] });
    update({ editor: null, editorLoading: false });
  }
  async function edit(id = ''): Promise<void> {
    if (
      !active() ||
      !canManage() ||
      writing ||
      state.busy ||
      state.roomOperations[id]?.pending ||
      state.accessBlocked ||
      lifetime.signal.aborted
    )
      return;
    closeEditor();
    update({ editor: null, editorLoading: true, error: '' });
    try {
      const maps = state.rooms?.directory.maps;
      if (!maps?.length) throw new Error('Map catalog unavailable. Refresh access.');
      const config = id
        ? await client.fetchQuery({
            queryKey: ['room-editor', identity()?.subject, id],
            queryFn: ({ signal }) => ports.room(id, signal),
          })
        : {
            name: 'Community room',
            mode: 'dm' as const,
            capacity: 16,
            bots: 0,
            rotation: maps.map((map) => map.id),
            scoreLimit: 50,
            timeLimitMinutes: 30,
            respawnSeconds: 5,
            forceRespawn: false,
          };
      if (!lifetime.signal.aborted) update({ editor: { id, config }, editorLoading: false });
    } catch (error) {
      if (!isCancelledError(error) && !lifetime.signal.aborted)
        update({
          editorLoading: false,
          error: error instanceof Error ? error.message : 'Room unavailable.',
        });
    }
  }
  async function run(allowed: boolean, action: () => Promise<void>): Promise<boolean> {
    if (!allowed || writing || state.busy || state.accessBlocked || lifetime.signal.aborted)
      return false;
    writing = true;
    update({ error: '', message: '' });
    try {
      await mutation.mutateAsync(action);
      return !lifetime.signal.aborted;
    } catch (error) {
      update({ error: error instanceof Error ? error.message : 'Operation failed.' });
      return false;
    } finally {
      writing = false;
    }
  }
  function roomProgress(id: string, pending: boolean, message: string, error = ''): void {
    update({
      roomOperations: { ...state.roomOperations, [id]: { pending, message, error } },
    });
  }
  async function watchRoom(id: string, name: string, operation: Operation): Promise<boolean> {
    try {
      for (let attempt = 0; attempt < 25; attempt++) {
        const seconds = Math.max(
          0,
          Math.ceil((Date.parse(operation.deadlineAt) - Date.now()) / 1000),
        );
        roomProgress(id, true, seconds > 0 ? `Applying in ${seconds}s…` : 'Applying changes…');
        await ports.wait(1000, lifetime.signal);
        if (lifetime.signal.aborted) return false;
        const result = await ports.operation(operation.id, lifetime.signal);
        if (lifetime.signal.aborted) return false;
        if (result.status === 'failed')
          throw new Error(result.error?.replaceAll('_', ' ') ?? 'Operation cancelled.');
        if (result.status === 'applied') {
          roomProgress(id, false, `${name}: changes applied.`);
          update({ message: `${name}: changes applied.` });
          await rooms.refresh();
          await refresh();
          return true;
        }
      }
      throw new Error('No final response. Refresh the room list before retrying.');
    } catch (error) {
      roomProgress(id, false, '', error instanceof Error ? error.message : 'Operation failed.');
      return false;
    }
  }
  async function saveRoom(config: RoomConfig, confirmed: boolean): Promise<boolean> {
    const editor = state.editor;
    let operation: Operation | null = null;
    const saved = await run(
      canManage() && !!editor && !state.roomOperations[editor?.id ?? '']?.pending,
      async () => {
        const error = validateRoom(config);
        if (error) throw new Error(error);
        const restart = !!editor!.id && roomRulesChanged(editor!.config, config);
        if (restart && !confirmed) throw new Error('Confirm the room restart.');
        if (editor!.id && !restart) {
          await ports.renameRoom(editor!.id, config.name);
        } else {
          operation = await ports.saveRoom(editor!.id, config);
        }
        if (lifetime.signal.aborted) return;
        closeEditor();
        if (operation) roomProgress(editor!.id, true, 'Players notified. Restart scheduled.');
        update({
          message: operation
            ? `${config.name}: restart scheduled.`
            : editor!.id
              ? `${config.name}: name saved. Match continues.`
              : `${config.name} created.`,
        });
        await rooms.refresh();
        await refresh();
      },
    );
    return saved && (operation ? watchRoom(editor!.id, config.name, operation) : true);
  }
  async function closeRoom(id: string): Promise<boolean> {
    let operation: Operation | undefined;
    const name = state.rooms?.directory.rooms.find((room) => room.id === id)?.info.name ?? 'Room';
    const saved = await run(canManage() && !state.roomOperations[id]?.pending, async () => {
      operation = await ports.closeRoom(id);
      if (!lifetime.signal.aborted) roomProgress(id, true, 'Players notified. Closing soon.');
    });
    return saved && !!operation && watchRoom(id, name, operation);
  }
  function moderate(target: string, minutes: number | null, reason = ''): Promise<boolean> {
    return run(canModerate() && (minutes !== 0 || canManage()) && !!target, async () => {
      if (minutes === null) await ports.kick(target);
      else await ports.ban(target, minutes, reason.trim());
      if (lifetime.signal.aborted) return;
      update({ message: 'Moderation applied.' });
      await rooms.refresh();
      await refresh();
    });
  }
  function saveRole(account: string, role: string): Promise<boolean> {
    return run(canManage() && (role !== 'admin' || identity()?.role === 'owner'), async () => {
      await ports.saveRole(account, role);
      if (lifetime.signal.aborted) return;
      update({ message: 'Role saved.' });
      await rooms.refresh();
      await refresh();
    });
  }
  function revoke(ban: Restriction): Promise<boolean> {
    const allowed =
      canManage() || (canModerate() && ban.actor === identity()?.subject && ban.expiresAt !== null);
    return run(allowed, async () => {
      await ports.revoke(ban.id);
      if (lifetime.signal.aborted) return;
      update({ message: 'Restriction revoked.' });
      await rooms.refresh();
      await refresh();
    });
  }
  function dispose(): void {
    lifetime.abort();
    void client.cancelQueries({ queryKey: ['staff'] });
    void client.cancelQueries({ queryKey: ['room-editor'] });
  }
  return {
    state,
    identity,
    canManage,
    canModerate,
    activate,
    refresh,
    closeEditor,
    edit,
    saveRoom,
    closeRoom,
    moderate,
    saveRole,
    revoke,
    dispose,
  };
}
