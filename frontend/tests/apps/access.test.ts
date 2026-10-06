import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchAccess } from '../../src/apps/match/access';
import type { AccessEvent } from '../../src/apps/match/access';
import { CLOSE, CLOSE_REASON } from '../../src/contracts/session';

const room = 'a'.repeat(32);
const server = 'b'.repeat(32);
const key = `baboreborn.rejoin.v1:wss://arena.example/ws?room=${room}`;
function fixture(search = '', store = new Map<string, string>()) {
  const events: AccessEvent[] = [];
  const calls: string[] = [];
  const timers: { action: () => void; delay: number; cancelled: boolean }[] = [];
  const services = {
    rooms() {
      calls.push('rooms');
      return Promise.resolve([{ id: room, name: 'Arena' }]);
    },
    identity() {
      calls.push('identity');
      return Promise.resolve({
        subject: 'guest:abc',
        central: 'https://accounts.example/account',
        expired: false,
      });
    },
    prepare(url: URL) {
      calls.push('prepare');
      const prepared = new URL(url);
      prepared.searchParams.set('profile', 'verified');
      return Promise.resolve({ url: prepared, info: { name: 'Live arena' } });
    },
    storage: {
      getItem: (name: string) => store.get(name) ?? null,
      setItem: (name: string, value: string) => {
        store.set(name, value);
      },
      removeItem: (name: string) => {
        store.delete(name);
      },
    },
    schedule(action: () => void, delay: number) {
      const timer = { action, delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  const access = new MatchAccess(
    new URL(`https://arena.example/rooms/${server}.${room}${search}`),
    { id: server, origin: 'https://arena.example' },
    services,
    (event) => events.push(event),
  );
  return { access, services, events, calls, timers, store };
}

void test('admission checks room, identity and compatibility in order before opening as a spectator', async () => {
  const f = fixture();
  await f.access.connect();
  assert.deepEqual(f.calls, ['rooms', 'identity', 'prepare']);
  assert.deepEqual(
    f.events.map((event) => event.type),
    ['checking', 'room', 'portal', 'identity', 'room', 'open'],
  );
  assert.equal(f.access.invite!.href, `https://arena.example/rooms/${server}.${room}`);
  assert.equal(f.access.url.searchParams.get('guest'), null);
  assert.equal(f.access.url.searchParams.get('profile'), 'verified');
  assert.deepEqual(f.events[2], { type: 'portal', url: 'https://accounts.example/rooms' });
  f.access.welcome();
  assert.equal(
    f.access.closed(1013, ''),
    false,
    'ordinary capacity errors remain owned by lifecycle',
  );
  assert.equal(f.access.closed(1006, ''), false);
});

void test('invalid invitations, missing rooms and expired accounts cannot reach socket preparation', async () => {
  const invalid = fixture('?unexpected=1');
  await invalid.access.connect();
  assert.deepEqual(invalid.calls, []);
  assert.equal(invalid.access.invite, null);
  assert.deepEqual(
    invalid.events.map((event) => event.type),
    ['room', 'failed'],
  );
  const missing = fixture();
  missing.services.rooms = () => Promise.resolve([]);
  await missing.access.connect();
  assert.equal(missing.events.at(-1)!.type, 'failed');
  assert.deepEqual(missing.calls, []);
  const expired = fixture();
  expired.services.identity = () =>
    Promise.resolve({
      subject: '',
      central: 'https://accounts.example',
      expired: true,
    });
  await expired.access.connect();
  assert.deepEqual(expired.events.at(-1), { type: 'leave', notice: 'authentication_expired' });
  assert.ok(!expired.calls.includes('prepare'));
});

void test('administrative recovery persists exactly three increasing retries and welcome clears recovery state', async () => {
  const store = new Map<string, string>();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const f = fixture('?rejoin=1', store);
    f.services.rooms = () => Promise.reject(new Error('Restarting'));
    await f.access.connect();
    assert.equal(store.get(key), String(attempt));
    assert.equal(f.timers[0]!.delay, attempt * 1000);
    f.access.closed(CLOSE.roomRestarted, '');
    assert.equal(f.timers.length, 1, 'duplicate close cannot consume another attempt');
    f.timers[0]!.action();
    const event = f.events.at(-1)!;
    assert.equal(event.type, 'replace');
    if (event.type === 'replace') assert.equal(event.url.searchParams.get('rejoin'), '1');
  }
  const exhausted = fixture('?rejoin=1', store);
  exhausted.access.closed(CLOSE.roomRestarted, '');
  assert.deepEqual(exhausted.events, [{ type: 'leave', notice: 'room_restart_reconnect_failed' }]);
  assert.equal(exhausted.timers.length, 0);
  const recovered = fixture('?rejoin=1', store);
  recovered.access.welcome();
  assert.equal(store.has(key), false);
  const clean = recovered.events.at(-1)!;
  assert.equal(clean.type, 'clean');
  if (clean.type === 'clean') assert.equal(clean.url.searchParams.has('rejoin'), false);
  assert.equal(recovered.access.closed(1006, ''), false);
});

void test('terminal close reasons take priority over restart and cancel pending navigation', () => {
  for (const [code, reason, notice] of [
    [CLOSE.rejected, '', 'access_ended'],
    [CLOSE.removed, CLOSE_REASON.roomClosed, CLOSE_REASON.roomClosed],
    [CLOSE.roomClosed, '', 'access_ended'],
    [1006, CLOSE_REASON.sanctionActive, CLOSE_REASON.sanctionActive],
    [1006, CLOSE_REASON.authenticationExpired, CLOSE_REASON.authenticationExpired],
    [CLOSE.removed, CLOSE_REASON.gameSessionReplaced, CLOSE_REASON.gameSessionReplaced],
    [CLOSE.roomFull, '', 'room_capacity_reduced_no_slot_available'],
  ] as const) {
    const f = fixture('?rejoin=1');
    f.access.closed(CLOSE.roomRestarted, '');
    assert.equal(f.access.closed(code, reason), true);
    assert.equal(f.timers[0]!.cancelled, true);
    f.timers[0]!.action();
    assert.deepEqual(f.events.at(-1), { type: 'leave', notice });
  }
});

void test('unavailable or corrupt retry storage fails to manual recovery without scheduling', () => {
  for (const value of ['NaN', '-1', '0.5']) {
    const f = fixture('?rejoin=1', new Map([[key, value]]));
    f.access.closed(CLOSE.roomRestarted, '');
    assert.deepEqual(f.events.at(-1), {
      type: 'leave',
      notice: 'room_restart_requires_manual_rejoin',
    });
    assert.equal(f.timers.length, 0);
  }
  const blocked = fixture();
  blocked.services.storage.getItem = () => {
    throw new Error('Blocked');
  };
  blocked.services.storage.setItem = () => {
    throw new Error('Blocked');
  };
  blocked.access.closed(CLOSE.roomRestarted, '');
  assert.equal(blocked.timers.length, 0);
  assert.deepEqual(blocked.events.at(-1), {
    type: 'leave',
    notice: 'room_restart_requires_manual_rejoin',
  });
});

void test('page disposal suppresses every pending admission stage and delayed redirect', async () => {
  for (const stage of ['rooms', 'identity', 'prepare'] as const) {
    const f = fixture();
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    // Keep each service's signature while pausing exactly one awaited boundary.
    if (stage === 'rooms')
      f.services.rooms = async () => {
        await gate;
        return [];
      };
    if (stage === 'identity')
      f.services.identity = async () => {
        await gate;
        return { subject: '', central: '', expired: true };
      };
    if (stage === 'prepare')
      f.services.prepare = async (url) => {
        await gate;
        return { url, info: { name: 'Late' } };
      };
    const pending = f.access.connect();
    await Promise.resolve();
    await Promise.resolve();
    f.access.dispose();
    const count = f.events.length;
    resolve();
    await pending;
    assert.equal(f.events.length, count);
  }
  const f = fixture();
  f.access.closed(CLOSE.roomRestarted, '');
  f.access.dispose();
  assert.equal(f.timers[0]!.cancelled, true);
  f.timers[0]!.action();
  assert.equal(f.events.at(-1)!.type, 'reconnecting');
});
