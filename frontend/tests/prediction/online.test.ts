import { createEquipment } from '../../src/core/equipment';
import { PROTOCOL } from '../../src/contracts/session';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Interpolation, Prediction } from '../../src/prediction/model';
import { parseServerMessage } from '../../src/network/protocol';
import { createPlayer, stepPlayer } from '../../src/core/simulation';
import { welcome, own, snap, batch, eventHeader } from '../support/online';
void test('wire validation accepts complete authority messages and rejects malformed data', () => {
  for (const message of [
    welcome,
    snap(1),
    { type: 'pong', version: PROTOCOL, tick: 4, nonce: 12.5, receivedAtMs: 1 },
  ]) {
    assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
  }
  const event = {
    ...eventHeader(1, 2),
    kind: 'shot' as const,
    shot: {
      from: { x: 1, y: 2, z: 0.2 },
      to: { x: 3, y: 4, z: 0 },
      killed: false,
    },
  };
  const delivery = batch(2, [], [event]);
  assert.deepEqual(parseServerMessage(JSON.stringify(delivery)), delivery);
  for (const message of [
    null,
    {},
    { ...welcome, version: PROTOCOL + 1 },
    { ...welcome, tickHz: 60 },
    { ...welcome, arena: { ...welcome.arena, spawns: [] } },
    { ...welcome, arena: { ...welcome.arena, width: 1e9 } },
    { ...welcome, shotGeometry: {} },
    { ...snap(1), players: [{ ...own(), state: { ...own().state, x: null } }] },
    { ...snap(1), players: [{ ...own(), status: ['alive'] }] },
    { ...snap(1), players: [{ ...own(), appearance: { template: 'external', colors: [] } }] },
    { ...snap(1), players: [{ ...own(), appearance: null }] },
    { ...delivery, cues: [{ ...event, shot: { ...event.shot, killed: 'yes' } }] },
    { type: 'pong', version: PROTOCOL, tick: -1, nonce: 1 },
    { type: 'pong', tick: 1, nonce: 1 },
  ])
    assert.throws(() => parseServerMessage(JSON.stringify(message)));
  assert.throws(() => parseServerMessage('{'));
  assert.throws(() => parseServerMessage(new Uint8Array()));
  assert.throws(() => parseServerMessage('{"type":"pong","version":1,"tick":1,"nonce":1e400}'));
});
void test('prediction applies input immediately and replays only unacknowledged input', () => {
  const p = new Prediction(welcome);
  p.reconcile(snap(1));
  const remote = own(),
    seed = { seed: remote.seed };
  const input = { x: 1, y: 0, aim: { x: 10, y: 4 }, fire: true };
  for (let tick = 0; tick < 40; tick++) {
    const command = p.advance(input)!.command;
    if (tick < 20)
      stepPlayer(remote.state, command, 1 / 120, p.geometry, [], seed, welcome.shotGeometry);
  }
  assert.ok(p.player!.vx > 0);
  const predicted = { ...p.player! };
  remote.ack = 20;
  remote.seed = seed.seed;
  p.reconcile(snap(21, remote), true);
  assert.deepEqual(p.player, predicted);
  assert.equal(p.pending.length, 20);
  assert.equal(p.correction, 0);
});
void test('authoritative displacement, death and new life replace predicted state', () => {
  const p = new Prediction(welcome);
  p.reconcile(snap(1));
  p.advance({ x: 1, y: 0, aim: { x: 10, y: 4 }, fire: true });
  const remote = own();
  remote.state.x = 8;
  remote.ack = 1;
  p.reconcile(snap(2, remote));
  assert.equal(p.player!.x, 8);
  remote.status = 'dead';
  remote.hp = 0;
  p.reconcile(snap(3, structuredClone(remote)));
  assert.equal(p.pending.length, 0);
  assert.equal(p.advance({ x: 1, y: 0, aim: { x: 10, y: 4 }, fire: true }), null);
  remote.life = 2;
  remote.status = 'alive';
  remote.hp = 100;
  remote.state = createPlayer({ x: 16, y: 16 }, 0);
  p.reconcile(snap(4, remote));
  assert.equal(p.player!.x, 16);
  assert.equal(p.player!.cooldown, 1);
});
void test('stale snapshots, protocol mismatch and bounded stalled prediction', () => {
  assert.throws(() => new Prediction({ ...welcome, version: PROTOCOL + 1 }));
  const p = new Prediction(welcome);
  p.reconcile(snap(10));
  assert.equal(p.reconcile(snap(9)), false);
  for (let i = 0; i < 100; i++) p.advance({ x: 1, y: 0, aim: { x: 10, y: 4 }, fire: true });
  assert.equal(p.pending.length, 60);
  p.release();
  assert.equal(p.pending.length, 0);
});
void test('opponents interpolate, freeze across loss, and never interpolate across respawn or departure', () => {
  const buffer = new Interpolation(),
    a = own(),
    b = own();
  b.state.x = 8;
  buffer.push(snap(0, a), 0);
  buffer.push(snap(12, b), 100);
  assert.equal(buffer.players(150, 120)[0]!.state.x, 6);
  assert.deepEqual(buffer.view(150, 120), { round: 1, from: 0, to: 12, latest: 12, alpha: 0.5 });
  assert.equal(buffer.players(900, 120)[0]!.state.x, 8);
  assert.deepEqual(buffer.view(900, 120), { round: 1, from: 12, to: 12, latest: 12, alpha: 0 });
  b.life = 2;
  b.state.x = 16;
  buffer.push(snap(24, b), 200);
  assert.equal(buffer.players(200, 120)[0]!.state.x, 16);
  buffer.push({ ...snap(36), players: [] }, 300);
  assert.equal(buffer.players(300, 120).length, 0);
});

void test('rendered shot references and player interpolation reset together on round and large gaps', () => {
  const buffer = new Interpolation();
  assert.equal(buffer.view(0, 120), undefined);
  buffer.push(snap(10), 0);
  const next = snap(14);
  next.match.round = 2;
  next.players[0]!.state.x = 16;
  buffer.push(next, 33);
  assert.equal(buffer.players(33, 120)[0]!.state.x, 16);
  assert.deepEqual(buffer.view(33, 120), { round: 2, from: 14, to: 14, latest: 14, alpha: 0 });
  const gap = snap(80);
  gap.match.round = 2;
  buffer.push(gap, 600);
  assert.deepEqual(buffer.view(600, 120), { round: 2, from: 80, to: 80, latest: 80, alpha: 0 });
});

void test('equipment snapshot history stays immutable through prediction and round changes flush replay', () => {
  const p = new Prediction(welcome),
    remote = own();
  remote.state.equipment = {
    ...createEquipment(),
    primary: 'shotgun',
    secondary: 'shield',
    grenades: 2,
    molotovs: 1,
    shells: 0,
    meleeDelay: 0,
    throwDelay: 0,
    protection: 0,
    action: '',
    secondaryActivated: false,
  };
  remote.state.cooldown = 0;
  const first = snap(1, remote);
  p.reconcile(first);
  p.advance({ x: 0, y: 0, aim: { x: 10, y: 4 }, fire: true });
  assert.equal(first.players[0]!.state.equipment.shells, 0);
  assert.equal(p.player!.equipment.shells, 1);
  const end = snap(2, remote);
  end.match.phase = 'intermission';
  p.reconcile(end);
  assert.equal(p.pending.length, 0);
  assert.equal(p.advance({ x: 1, y: 0, aim: { x: 10, y: 4 }, fire: true }), null);
  const next = snap(3, remote);
  next.match.round = 2;
  p.reconcile(next);
  assert.equal(p.pending.length, 0);
});

void test('combat effects and authored heights are validated at the wire boundary', () => {
  const message = batch(1, [], [{ ...eventHeader(1, 1), kind: 'explosion', radius: 1.5 }]);
  assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
  assert.throws(
    () =>
      parseServerMessage(
        JSON.stringify({ ...message, cues: [{ ...message.cues[0], radius: -1 }] }),
      ),
    /Malformed/,
  );
  const map = structuredClone(welcome);
  map.arena = { ...map.arena, walls: [{ x: 1, y: 1, w: 1, h: 1, height: 3 }] };
  assert.deepEqual(parseServerMessage(JSON.stringify(map)), map);
  map.arena = { ...map.arena, walls: [{ x: 1, y: 1, w: 1, h: 1, height: 0 }] };
  assert.throws(() => parseServerMessage(JSON.stringify(map)), /Malformed/);
});

void test('every local status requires complete equipment and a boolean activation flag', () => {
  for (const status of ['spectator', 'alive', 'dead'] as const) {
    const message = snap(1, { ...own(), status });
    const wire = JSON.parse(JSON.stringify(message)) as {
      local: { state: { equipment?: { secondaryActivated: unknown } } };
    };
    wire.local.state.equipment!.secondaryActivated = 'yes';
    assert.throws(() => parseServerMessage(JSON.stringify(wire)), /Malformed/);
    delete wire.local.state.equipment;
    assert.throws(() => parseServerMessage(JSON.stringify(wire)), /Malformed/);
    assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
  }
});

void test('wire profile requires bounded plain display names', () => {
  for (const nickname of [undefined, '', '<script>', 'a'.repeat(21), 'line\nname']) {
    const message = snap(1);
    const raw = JSON.parse(JSON.stringify(message)) as { players: { nickname?: string }[] };
    if (nickname === undefined) delete raw.players[0]!.nickname;
    else raw.players[0]!.nickname = nickname;
    assert.throws(() => parseServerMessage(JSON.stringify(raw)));
  }
});

void test('projectile presentation reconstructs flight on playback time without reviving expired entities', () => {
  const buffer = new Interpolation();
  const a = snap(120),
    b = snap(132);
  const projectile = {
    id: 17,
    kind: 'rocket' as const,
    ownerId: 1,
    bornTick: 110,
    motion: 'rocket' as const,
    motionTick: 120,
    attachedId: 0,
    expiresTick: 500,
    velocity: { x: 10, y: 0, z: 0 },
    position: { x: 1, y: 2, z: 0.2 },
  };
  a.projectiles = [projectile];
  b.projectiles = [{ ...projectile, motionTick: 132, position: { x: 2, y: 4, z: 0.6 } }];
  buffer.push(a, 1000);
  buffer.push(b, 1100);
  const original = structuredClone(b);
  const rendered = buffer.projectiles(1150, 120)[0]!.position;
  assert.ok(rendered.x > 1 && rendered.x < 2);
  assert.equal(rendered.y, 2);
  assert.equal(rendered.z, 0.2);
  assert.deepEqual(buffer.projectiles(1800, 120)[0]!.position, b.projectiles[0]!.position);
  assert.deepEqual(b, original);
  buffer.push(snap(144), 1200);
  assert.deepEqual(buffer.projectiles(1200, 120), []);
});
void test('projectile art snaps to authority on kind, birth or round changes', () => {
  for (const change of ['kind', 'birth', 'round']) {
    const buffer = new Interpolation(),
      a = snap(120),
      b = snap(132);
    a.projectiles = [
      {
        id: 17,
        kind: 'molotov',
        ownerId: 1,
        bornTick: 110,
        motion: 'fixed' as const,
        motionTick: 0,
        attachedId: 0,
        expiresTick: 500,
        velocity: { x: 1, y: 0, z: 0 },
        position: { x: 1, y: 2, z: 0.2 },
      },
    ];
    b.projectiles = structuredClone(a.projectiles);
    b.projectiles[0]!.position.x = 9;
    if (change === 'kind') b.projectiles[0]!.kind = 'flame';
    if (change === 'birth') b.projectiles[0]!.bornTick = 130;
    if (change === 'round') b.match.round = 2;
    buffer.push(a, 1000);
    buffer.push(b, 1100);
    assert.equal(buffer.projectiles(1150, 120)[0]!.position.x, 9);
  }
});

void test('Mini Bot projectiles require bounded authoritative orientation and shot time', () => {
  const state = snap(120);
  const turret = { angle: Math.PI / 2, lastShotTick: 116 };
  state.projectiles = [
    {
      id: 1,
      kind: 'minibot',
      ownerId: 1,
      bornTick: 100,
      expiresTick: 600,
      motion: 'fixed' as const,
      motionTick: 0,
      attachedId: 0,
      position: { x: 5, y: 4, z: 0.1 },
      velocity: { x: 0, y: 0, z: 0 },
      turret,
    },
  ];
  assert.deepEqual(parseServerMessage(JSON.stringify(state)), state);
  for (const invalid of [
    undefined,
    { angle: null, lastShotTick: 0 },
    { angle: 4, lastShotTick: 0 },
    { angle: 0, lastShotTick: 121 },
    { angle: 0, lastShotTick: -1 },
  ]) {
    assert.throws(() =>
      parseServerMessage(
        JSON.stringify({ ...state, projectiles: [{ ...state.projectiles[0], turret: invalid }] }),
      ),
    );
  }
  assert.throws(() => parseServerMessage(JSON.stringify({ ...state, version: PROTOCOL + 1 })));
});

void test('CTF prediction blocks movement into a teammate during advance and replay', () => {
  const local = own();
  local.team = 'blue';
  const teammate = own();
  teammate.id = 2;
  teammate.team = 'blue';
  teammate.state.x = 4.7;
  const snapshot = snap(400, local);
  snapshot.match.rules.mode = 'ctf';
  snapshot.players.push(teammate);
  const prediction = new Prediction(welcome);
  prediction.reconcile(snapshot);
  const input = { x: 1, y: 0, aim: { x: 10, y: 4 }, fire: false };
  for (let i = 0; i < 50; i++) {
    prediction.advance(input);
    assert.ok(prediction.player!.x <= teammate.state.x - 0.5, 'predicted body entered teammate');
  }
  prediction.reconcile({ ...snapshot, tick: 404 });
  assert.ok(prediction.player!.x <= teammate.state.x - 0.5, 'replay entered teammate');
  assert.equal(teammate.state.x, 4.7, 'prediction mutated remote authority');
});

void test('contact prediction respects spawn grace, death and departure', () => {
  for (const state of ['grace', 'dead', 'spectator', 'departed'] as const) {
    const local = own();
    const other = own();
    other.id = 2;
    other.state.x = 4.7;
    if (state === 'grace') other.bornTick = 400;
    if (state === 'dead' || state === 'spectator') other.status = state;
    const snapshot = snap(400, local);
    snapshot.players.push(other);
    const prediction = new Prediction(welcome);
    prediction.reconcile(snapshot);
    if (state === 'departed') prediction.reconcile(snap(404, local));
    for (let i = 0; i < 50; i++)
      prediction.advance({ x: 1, y: 0, aim: { x: 10, y: 4 }, fire: false });
    assert.ok(prediction.player!.x > 4.7, state);
  }
});
