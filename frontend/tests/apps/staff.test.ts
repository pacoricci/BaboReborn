import { onlineManager } from '@tanstack/solid-query';
import { createComputed } from 'solid-js';
import { queryScope, flushQueries } from '../support/queries';
import { roomRulesChanged, validateRoom } from '../../src/apps/management/rules';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagement } from '../../src/apps/management/application';
import type { ManagementData } from '../../src/apps/management/application';
import { createStaff } from '../../src/apps/management/staff-application';
import type {
  StaffData,
  StaffPorts,
  Operation,
  RoomEditor,
} from '../../src/apps/management/staff-application';
import type { RoomConfig } from '../../src/contracts/server';

const deadlineAt = new Date(0).toISOString();
const roomID = 'a'.repeat(32);
const config: RoomConfig = {
  name: 'Arena',
  mode: 'dm',
  capacity: 16,
  bots: 1,
  rotation: ['yard'],
  scoreLimit: 50,
  timeLimitMinutes: 30,
  respawnSeconds: 1,
  forceRespawn: false,
};
const empty: StaffData = { people: [], restrictions: [], roles: [], events: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(ports: Partial<StaffPorts> = {}, role = 'owner') {
  let data: ManagementData = {
    identity: { subject: 'account:owner', role, expired: false, central: '', loginAvailable: true },
    directory: {
      schema: 1,
      maxRooms: 8,
      rooms: [],
      maps: [
        { id: 'yard', name: 'The Yard', ctf: false },
        { id: 'flags', name: 'Flags', ctf: true },
      ],
    },
  };
  const calls: unknown[] = [];
  const scope = queryScope((client) => {
    const rooms = createManagement({ load: () => Promise.resolve(data) }, client);
    const app = createStaff(
      rooms,
      {
        load: () => Promise.resolve(empty),
        room: () => Promise.resolve(config),
        saveRoom: (id, config) => {
          calls.push({ id, config });
          return Promise.resolve(id ? { id: 'op', deadlineAt, status: 'pending' } : null);
        },
        renameRoom: (id, name) => {
          calls.push({ id, name });
          return Promise.resolve();
        },
        closeRoom: (id) => {
          calls.push({ id });
          return Promise.resolve({ id: 'op', deadlineAt, status: 'pending' });
        },
        kick: () => {
          calls.push('moderate');
          return Promise.resolve();
        },
        ban: () => {
          calls.push('ban');
          return Promise.resolve();
        },
        saveRole: () => {
          calls.push('role');
          return Promise.resolve();
        },
        revoke: () => {
          calls.push('revoke');
          return Promise.resolve();
        },
        operation: () => Promise.resolve({ id: 'op', deadlineAt, status: 'applied' }),
        wait: () => Promise.resolve(),
        ...ports,
      },
      client,
    );
    return { rooms, app };
  });
  const { rooms, app } = scope.value;
  await rooms.refresh();
  await flushQueries();
  app.activate(true);
  await app.refresh();
  await flushQueries();
  return {
    app,
    rooms,
    calls,
    setRole: async (role: string) => {
      data = { ...data, identity: { ...data.identity, role } };
      await rooms.refresh();
      await flushQueries();
    },
  };
}
void test('room rules distinguish a harmless rename and enforce valid capacity and rotation', () => {
  assert.equal(roomRulesChanged(config, { ...config, name: 'New name' }), false);
  assert.equal(roomRulesChanged(config, { ...config, rotation: ['flags'] }), true);
  assert.equal(roomRulesChanged(config, { ...config, forceRespawn: true }), true);
  assert.match(validateRoom({ ...config, capacity: 15, bots: 15 })!, /one slot/);
  assert.ok(validateRoom({ ...config, capacity: NaN }));
  assert.ok(validateRoom({ ...config, rotation: Array.from({ length: 17 }, () => 'yard') }));
  assert.equal(validateRoom(config), null);
});
void test('renaming a room sends only metadata without restart confirmation or an operation', async () => {
  const { app, calls } = await fixture();
  await app.edit(roomID);
  assert.equal(await app.saveRoom({ ...config, name: 'New name' }, false), true);
  assert.deepEqual(calls, [{ id: roomID, name: 'New name' }]);
  assert.equal(app.state.editor, null);
  assert.match(app.state.message, /Match continues/);
  assert.deepEqual(app.state.roomOperations, {});
  app.dispose();
});
void test('closing or leaving an editor prevents a delayed response from reopening it', async () => {
  const pending = deferred<RoomConfig>();
  const { app } = await fixture({ room: () => pending.promise });
  const edit = app.edit(roomID);
  app.closeEditor();
  pending.resolve(config);
  await edit;
  assert.equal(app.state.editor, null);
  const editAgain = app.edit(roomID);
  app.activate(false);
  await editAgain;
  assert.equal(app.state.editor, null);
  app.dispose();
});
void test('stale staff reads cannot overwrite a newer completed list', async () => {
  const first = deferred<StaffData>();
  let reads = 0;
  const latest = { ...empty, people: [{ subject: 'guest:new', nickname: 'New', room: roomID }] };
  const result = await fixture({
    load: () => (++reads === 1 ? first.promise : Promise.resolve(latest)),
  });
  first.resolve(empty);
  await Promise.resolve();
  assert.deepEqual(result.app.state.data, latest);
  result.app.dispose();
});
void test('room restart requires confirmation, serializes writes and observes authority completion', async () => {
  const pending = deferred<Operation | null>();
  const { app, calls } = await fixture({
    saveRoom: (id, value) => {
      calls.push({ id, value });
      return pending.promise;
    },
  });
  await app.edit(roomID);
  assert.equal(await app.saveRoom({ ...config, capacity: 15 }, false), false);
  assert.equal(calls.length, 0);
  const save = app.saveRoom({ ...config, capacity: 15 }, true);
  assert.equal(await app.saveRoom({ ...config, capacity: 15 }, true), false);
  assert.deepEqual(calls, [{ id: roomID, value: { ...config, capacity: 15 } }]);
  pending.resolve({ id: 'op', deadlineAt, status: 'pending' });
  assert.equal(await save, true);
  assert.equal(app.state.editor, null);
  assert.equal(app.state.roomOperations[roomID]?.pending, false);
  assert.match(app.state.roomOperations[roomID].message, /changes applied/);
  app.dispose();
});
void test('role changes remove privileged editor state and forbid newly unauthorized commands', async () => {
  const { app, calls, setRole } = await fixture();
  await app.edit();
  await setRole('player');
  assert.equal(app.state.editor, null);
  assert.equal(await app.closeRoom(roomID), false);
  assert.equal(await app.saveRole('account', 'admin'), false);
  assert.equal(await app.moderate('guest:one', null), false);
  assert.equal(calls.length, 0);
  app.dispose();
});
void test('moderators can kick but cannot assign roles or permanent bans', async () => {
  const { app, calls } = await fixture({}, 'moderator');
  assert.equal(await app.moderate('guest:one', 0), false);
  assert.equal(await app.saveRole('account', 'moderator'), false);
  assert.equal(await app.moderate('guest:one', null), true);
  assert.deepEqual(calls, ['moderate']);
  app.dispose();
});
void test('server rejection and bounded operation timeout remain errors, never success', async () => {
  const failed = await fixture({
    operation: () =>
      Promise.resolve({ id: 'op', deadlineAt, status: 'failed', error: 'permission_changed' }),
  });
  assert.equal(await failed.app.closeRoom(roomID), false);
  assert.match(failed.app.state.roomOperations[roomID]!.error, /permission changed/);
  failed.app.dispose();
  let polls = 0;
  const timeout = await fixture({
    operation: () => {
      polls++;
      return Promise.resolve({ id: 'op', deadlineAt, status: 'pending' });
    },
  });
  assert.equal(await timeout.app.closeRoom(roomID), false);
  assert.equal(polls, 25);
  assert.match(timeout.app.state.roomOperations[roomID]!.error, /No final response/);
  timeout.app.dispose();
});
void test('disposal cancels operation waits without polling or notifying an abandoned page', async () => {
  let waiting: AbortSignal | undefined;
  let finish!: () => void;
  let polls = 0;
  const { app } = await fixture({
    wait: (_ms, signal) =>
      new Promise((resolve) => {
        waiting = signal;
        finish = resolve;
        signal.addEventListener('abort', resolve.bind(null, undefined), { once: true });
      }),
    operation: () => {
      polls++;
      return Promise.resolve({ id: 'op', deadlineAt, status: 'applied' });
    },
  });
  let updates = 0;
  const watch = queryScope(() =>
    createComputed(() => {
      JSON.stringify(app.state);
      updates++;
    }),
  );
  const close = app.closeRoom(roomID);
  for (let i = 0; i < 10 && !waiting; i++) await Promise.resolve();
  assert.ok(waiting);
  const before = updates;
  app.dispose();
  finish();
  await close;
  assert.equal(waiting.aborted, true);
  assert.equal(polls, 0);
  assert.equal(updates, before);
  watch.dispose();
});

void test('losing room-management permission closes its editor even when moderation remains', async () => {
  const { app, setRole } = await fixture();
  await app.edit();
  assert.ok(app.state.editor);
  await setRole('moderator');
  assert.equal(app.state.editor, null);
  assert.equal(app.canModerate(), true);
  app.dispose();
});

void test('a pending restart blocks only its room while another room remains editable', async () => {
  const waiting = deferred<void>();
  const { app, calls } = await fixture({ wait: () => waiting.promise });
  const closing = app.closeRoom(roomID);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(app.state.busy, false);
  assert.equal(app.state.roomOperations[roomID]?.pending, true);
  assert.equal(await app.closeRoom(roomID), false);
  await app.edit(roomID);
  assert.equal(app.state.editor, null);
  await app.edit('b'.repeat(32));
  assert.equal((app.state.editor as RoomEditor | null)?.id, 'b'.repeat(32));
  assert.equal(await app.moderate('guest:one', null), true);
  assert.ok(calls.includes('moderate'));
  waiting.resolve();
  assert.equal(await closing, true);
  app.dispose();
});

void test('offline administration attempts the request immediately instead of queuing a command for reconnect', async () => {
  const { app, calls } = await fixture();
  onlineManager.setOnline(false);
  try {
    const command = app.moderate('guest:one', null);
    await flushQueries();
    assert.deepEqual(calls, ['moderate']);
    assert.equal(await command, true);
  } finally {
    onlineManager.setOnline(true);
    app.dispose();
  }
});

void test('moderation omits kick reasons and permits bans without a reason', async () => {
  const sent: unknown[] = [];
  const { app } = await fixture({
    kick: (...args) => {
      sent.push(['kick', ...args]);
      return Promise.resolve();
    },
    ban: (...args) => {
      sent.push(['ban', ...args]);
      return Promise.resolve();
    },
  });
  assert.equal(await app.moderate('guest:one', null, 'stale ban draft'), true);
  assert.equal(await app.moderate('guest:one', 5), true);
  assert.equal(await app.moderate('guest:one', 0), true);
  assert.equal(await app.moderate('guest:one', 30, '  report  '), true);
  assert.deepEqual(sent, [
    ['kick', 'guest:one'],
    ['ban', 'guest:one', 5, ''],
    ['ban', 'guest:one', 0, ''],
    ['ban', 'guest:one', 30, 'report'],
  ]);
  app.dispose();
});
