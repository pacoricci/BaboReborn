import { encodeDelivery } from '../support/encoding';
import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreSnapshot } from '../../src/contracts/snapshot';
import type { Snapshot, StateUpdate } from '../../src/contracts/session';
import { parseDelivery } from '../../src/network/protocol';
import { snap, own, remote } from '../support/online';

function sparse(s: Snapshot): StateUpdate {
  const update: StateUpdate = structuredClone(s);
  delete update.items;
  delete update.projectiles;
  delete update.match.rules;
  delete update.match.ranking;
  delete update.match.scores;
  for (const p of update.players) {
    delete p.team;
    delete p.nickname;
    delete p.appearance;
  }
  return update;
}
function decode(body: StateUpdate): StateUpdate {
  const frame = parseDelivery(
    encodeDelivery({
      type: 'delivery',
      version: body.version,
      connection: 'groups',
      sequence: 2,
      generation: 1,
      eventThrough: 0,
      sentAtMs: 1000,
      kind: 'state',
      body,
    }),
  );
  assert.equal(frame.kind, 'state');
  return frame.body;
}

void test('sparse groups preserve metadata by ID, scores and rules without delaying combat', () => {
  const before = snap(1);
  before.players.push({ ...remote(own()), id: 2, nickname: 'Second', team: 'red' });
  before.match.ranking = [{ id: 2, team: 'red', score: 7, kills: 7, deaths: 0 }];
  before.match.scores.red = 7;
  const preserved = structuredClone(before);
  const next = sparse(before);
  next.tick = 2;
  next.players.reverse();
  next.players[0]!.hp = 20;
  next.players[0]!.state.x = 8;
  const restored = restoreSnapshot(decode(next), before);
  assert.equal(restored.players[0]!.nickname, 'Second');
  assert.equal(restored.players[0]!.team, 'red');
  assert.equal(restored.players[0]!.hp, 20);
  assert.equal(restored.players[0]!.state.x, 8);
  assert.deepEqual(restored.match, before.match);
  assert.deepEqual(before, preserved);
  assert.equal(next.players[0]!.team, undefined);
  const changed = sparse(restored);
  changed.players[0] = {
    ...changed.players[0]!,
    team: 'blue',
    nickname: 'Renamed',
    appearance: own().appearance,
  };
  changed.match.ranking = [{ id: 2, team: 'blue', score: 8, kills: 8, deaths: 0 }];
  changed.match.scores = { blue: 8, red: 0 };
  const team = restoreSnapshot(decode(changed), restored);
  assert.equal(team.players[0]!.team, 'blue');
  assert.equal(team.match.ranking[0]!.team, 'blue');
  assert.equal(restored.players[0]!.team, 'red');
});

void test('missing baselines, partial groups and unknown member metadata are rejected', () => {
  const before = snap(1);
  const next = sparse(before);
  assert.throws(() => restoreSnapshot(decode(next), null), /installed/);
  assert.throws(
    () => restoreSnapshot({ ...next, match: { ...next.match, round: 2 } }, before),
    /installed/,
  );
  assert.throws(() => decode({ ...next, players: [{ ...next.players[0]!, team: 'blue' }] }));
  assert.throws(() => decode({ ...next, match: { ...next.match, scores: { blue: 1, red: 0 } } }));
  assert.throws(() =>
    decode({ ...next, match: { ...next.match, rules: null } } as unknown as StateUpdate),
  );
  const joined = { ...next, players: [...next.players, { ...next.players[0]!, id: 99 }] };
  assert.throws(() => restoreSnapshot(decode(joined), before), /player metadata/);
  const removed = restoreSnapshot({ ...next, players: [] }, before);
  assert.throws(() => restoreSnapshot(next, removed), /player metadata/);
  const installed = restoreSnapshot(snap(10), null);
  assert.deepEqual(restoreSnapshot(sparse(installed), installed), installed);
});

void test('CTF carrier relationships are validated after restoring omitted teams and rules', () => {
  const before = snap(1, { ...own(), team: 'blue' });
  before.match.rules.mode = 'ctf';
  before.flags = [
    { team: 'blue', state: 'home', carrierId: 0, position: { x: 1, y: 1 } },
    { team: 'red', state: 'carried', carrierId: 1, position: { x: 4, y: 4 } },
  ];
  const next = sparse(before);
  assert.equal(restoreSnapshot(decode(next), before).players[0]!.team, 'blue');
  const bad = structuredClone(next);
  bad.flags![0]!.state = 'carried';
  bad.flags![0]!.carrierId = 1;
  bad.flags![1]!.state = 'home';
  bad.flags![1]!.carrierId = 0;
  assert.throws(() => restoreSnapshot(decode(bad), before), /flags/);
  assert.throws(() => restoreSnapshot(decode({ ...next, flags: [] }), before), /flags/);
});

void test('entity deltas retain immutable references and explicitly remove IDs', () => {
  const before = snap(1);
  const entity = {
    id: 9,
    kind: 'grenade' as const,
    ownerId: 1,
    bornTick: 1,
    expiresTick: 361,
    attachedId: 0,
    motion: 'fixed' as const,
    motionTick: 1,
    position: { x: 4, y: 4, z: 0.15 },
    velocity: { x: 0, y: 0, z: 0 },
  };
  before.projectiles = [entity];
  const next = sparse(before);
  next.tick = 2;
  next.projectiles = { upsert: [{ ...entity, id: 10 }], remove: [] };
  const restored = restoreSnapshot(decode(next), before);
  assert.equal(restored.projectiles[0], entity);
  assert.equal(before.projectiles.length, 1);
  const remove = sparse(restored);
  remove.tick = 3;
  remove.projectiles = { upsert: [], remove: [9, 10] };
  assert.deepEqual(restoreSnapshot(decode(remove), restored).projectiles, []);
  for (const patch of [
    { upsert: [entity, entity], remove: [] },
    { upsert: [entity], remove: [9] },
    { upsert: [], remove: [9, 9] },
  ])
    assert.throws(() => decode({ ...next, projectiles: patch }));
  assert.throws(
    () => restoreSnapshot({ ...next, projectiles: { upsert: [], remove: [999] } }, before),
    /Removal/,
  );
  assert.throws(() => decode({ ...next, projectiles: [entity] }));
  assert.throws(
    () => restoreSnapshot({ ...next, match: { ...next.match, round: 2 } }, before),
    /installed/,
  );
});

void test('nickname colors survive sparse updates and clear with uncolored metadata', () => {
  const before = snap(1);
  before.players[0]!.nicknameColors = 'ff0000'.repeat(before.players[0]!.nickname.length);
  const update = sparse(before);
  delete update.players[0]!.nicknameColors;
  const restored = restoreSnapshot(decode(update), before);
  assert.equal(restored.players[0]!.nicknameColors, before.players[0]!.nicknameColors);
  const reset: StateUpdate = structuredClone(before);
  delete reset.items;
  delete reset.projectiles;
  delete reset.players[0]!.nicknameColors;
  assert.equal(restoreSnapshot(decode(reset), restored).players[0]!.nicknameColors, undefined);
  assert.ok(before.players[0]!.nicknameColors);
});
