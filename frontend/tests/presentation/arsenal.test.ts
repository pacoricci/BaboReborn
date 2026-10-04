import { defaultSettings } from '../../src/player/player-preferences';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, stepPlayer } from '../../src/core/simulation';
import { createEquipment, PRIMARIES, SECONDARIES } from '../../src/core/equipment';
import { photonDamage } from '../../src/core/weapons';
import { createCollisionGrid } from '../../src/core/grid';
import { parseServerMessage } from '../../src/network/protocol';
import { CLOSE, PROTOCOL } from '../../src/contracts/session';
import { snap, own } from '../support/online';
import { readSettings, saveSettings } from '../../src/player/player-settings';
const world = { walls: [], grid: createCollisionGrid({ x: 0, y: 0, w: 36, h: 36 }, []) };
const g = {
  muzzleOffset: 0.4,
  muzzleSide: 0.16,
  muzzleHeight: 0.25,
  maxDistance: 128,
  wallHeight: 0.7,
};
const input = { x: 0, y: 0, aim: { x: 30, y: 18 }, fire: true };
const dt = 1 / 120;
function player(primary: (typeof PRIMARIES)[number]) {
  const p = createPlayer({ x: 18, y: 18 }, 0);
  p.equipment = createEquipment(primary);
  p.cooldown = 0;
  return p;
}
void test('Sniper fires two unscoped or three scoped 34 HP rays with one recoil', () => {
  for (const [height, rays, hp] of [
    [7, 2, 32],
    [12, 3, 0],
  ]) {
    const p = player('sniper');
    p.equipment.scopeHeight = height!;
    const body = { id: 2, x: 20, y: 18, radius: 0.25, hp: 100 };
    const shot = stepPlayer(p, input, dt, world, [body], { seed: 123 }, g)!;
    assert.equal(shot.pellets?.length, rays);
    assert.equal(body.hp, hp);
    assert.equal(p.vx, -3);
    assert.equal(p.cooldown, 2);
  }
});
void test('Sniper zoom rises with distant aim and recovers with close aim', () => {
  const p = player('sniper');
  for (let i = 0; i < 120; i++)
    stepPlayer(p, { ...input, fire: false }, dt, world, [], { seed: 1 }, g);
  assert.ok(p.equipment.scopeHeight >= 10);
  for (let i = 0; i < 240; i++)
    stepPlayer(
      p,
      { ...input, fire: false, aim: { x: p.x, y: p.y } },
      dt,
      world,
      [],
      { seed: 1 },
      g,
    );
  assert.ok(p.equipment.scopeHeight < 5.1);
});
void test('Photon requires accumulated half-second charge, penetrates bodies and falls off with distance', () => {
  const p = player('photon'),
    random = { seed: 1 };
  const bodies = [
    { id: 1, x: 20, y: 18, radius: 0.25, hp: 100 },
    { id: 2, x: 25, y: 18, radius: 0.25, hp: 100 },
  ];
  for (let i = 0; i < 60; i++)
    assert.equal(stepPlayer(p, input, dt, world, bodies, random, g), null);
  assert.ok(stepPlayer(p, input, dt, world, bodies, random, g));
  assert.ok(bodies[0]!.hp < bodies[1]!.hp && bodies[1]!.hp < 100);
  assert.equal(p.equipment.charge, 0);
  assert.equal(p.cooldown, 1.5);
  assert.ok(photonDamage(1) > photonDamage(10));
});
void test('Chain Gun recovers during sustained fire, overheats, blocks and resumes above half reserve', () => {
  const p = player('chain'),
    random = { seed: 7 };
  let shots = 0;
  for (let i = 0; i < 1200 && !p.equipment.overheated; i++)
    if (stepPlayer(p, input, dt, world, [], random, g)) shots++;
  assert.ok(p.equipment.overheated);
  assert.ok(shots > 20 && shots < 45);
  assert.equal(stepPlayer(p, input, dt, world, [], random, g), null);
  for (let i = 0; i < 240; i++) stepPlayer(p, { ...input, fire: false }, dt, world, [], random, g);
  assert.equal(p.equipment.overheated, false);
  assert.ok(stepPlayer(p, input, dt, world, [], random, g));
});
void test('Dual alternates real muzzle anchors and applies 0.8 recoil once', () => {
  const p = player('dual'),
    random = { seed: 4 };
  const a = stepPlayer(p, input, dt, world, [], random, g)!;
  assert.equal(p.vx, -0.8);
  p.cooldown = 0;
  p.x = 18;
  p.y = 18;
  p.vx = 0;
  p.angle = 0;
  const b = stepPlayer(p, input, dt, world, [], random, g)!;
  assert.ok(a.from.y < 18 && b.from.y > 18);
  assert.equal(p.cooldown, 0.1);
});
void test('Flamethrower shrinks its ray under continuous fire and restores range after a pause', () => {
  const p = player('flamethrower'),
    // This seed makes the first angular deviation zero, isolating range from floor hits.
    random = { seed: 2782269413 };
  const first = stepPlayer(p, input, dt, world, [], random, g)!;
  assert.ok(Math.hypot(first.to.x - first.from.x, first.to.y - first.from.y) > 7.8);
  let last = first;
  for (let i = 0; i < 180; i++) {
    const shot = stepPlayer(p, input, dt, world, [], random, g);
    if (shot) last = shot;
  }
  assert.ok(Math.hypot(last.to.x - last.from.x, last.to.y - last.from.y) <= 1.01);
  for (let i = 0; i < 30; i++) stepPlayer(p, { ...input, fire: false }, dt, world, [], random, g);
  random.seed = 2782269413;
  const restored = stepPlayer(p, input, dt, world, [], random, g)!;
  assert.ok(Math.hypot(restored.to.x - restored.from.x, restored.to.y - restored.from.y) > 7.8);
});
void test('Bazooka requests launch without hitscan damage, then remote detonation after 0.25 seconds', () => {
  const p = player('bazooka'),
    body = { id: 2, x: 20, y: 18, radius: 0.25, hp: 100 },
    random = { seed: 1 };
  const shot = stepPlayer(p, input, dt, world, [body], random, g)!;
  assert.equal(shot.hit, false);
  assert.equal(body.hp, 100);
  assert.equal(p.equipment.primaryAction, 'rocket');
  for (let i = 0; i < 29; i++) {
    stepPlayer(p, input, dt, world, [body], random, g);
    assert.notEqual(p.equipment.primaryAction, 'detonate');
  }
  stepPlayer(p, input, dt, world, [body], random, g);
  assert.equal(p.equipment.primaryAction, 'detonate');
});
void test('wire decoder accepts every loadout and rejects malformed state or protocol mismatch', () => {
  for (const primary of PRIMARIES)
    for (const secondary of SECONDARIES) {
      const p = own();
      p.state.equipment = createEquipment(primary, secondary);
      const state = snap(1, p);
      assert.equal(parseServerMessage(JSON.stringify(state)).type, 'snapshot');
      for (const patch of [
        { heat: -0.1 },
        { overheated: 1 },
        { charge: NaN },
        { scopeHeight: 99 },
        { primary: 'laser' },
        { secondary: 'laser' },
        { action: 'unsupported' },
        { primaryAction: 'launch-laser' },
        { barrel: 9 },
      ]) {
        const bad = structuredClone(state);
        Object.assign(bad.local!.state.equipment, patch);
        assert.throws(() => parseServerMessage(JSON.stringify(bad)));
      }
      assert.throws(() => parseServerMessage(JSON.stringify({ ...state, version: PROTOCOL + 1 })));
    }
});
void test('local preferences retain supported equipment and reset an invalid secondary', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored = '';
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    },
  });
  try {
    for (const primary of PRIMARIES)
      for (const secondary of SECONDARIES) {
        assert.ok(
          saveSettings({
            ...defaultSettings,
            nickname: 'Test',
            primary,
            secondary,
            sound: true,
            collectDiagnostics: false,
          }),
        );
        assert.equal(readSettings().primary, primary);
        assert.equal(readSettings().secondary, secondary);
      }
    stored = JSON.stringify({ ...defaultSettings, primary: 'sniper', secondary: 'unsupported' });
    assert.equal(readSettings().secondary, 'knives');
    assert.equal(readSettings().primary, 'sniper');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

void test('actual Go authority snapshots decode through primary fire, deployments, deaths and explosions', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync('go', ['run', './backend/cmd/arsenal-wire'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const entities = new Set<string>(),
    shots = new Set<string>();
  let explosion = false,
    deaths = false;
  for (const line of output.trim().split('\n')) {
    const message = parseServerMessage(line);
    if (message.type === 'snapshot') {
      for (const p of message.projectiles) entities.add(p.kind);
      if (message.players.some((p) => p.status === 'dead')) deaths = true;
    } else if (message.type === 'events') {
      for (const e of message.cues) if (e.kind === 'shot' && e.shot.kind) shots.add(e.shot.kind);
      if (message.cues.some((e) => e.kind === 'rocket-explosion')) explosion = true;
    } else assert.fail('Unexpected authority body.');
  }
  for (const kind of ['rocket', 'minibot']) assert.ok(entities.has(kind), kind);
  for (const primary of PRIMARIES.filter((p) => p !== 'bazooka'))
    assert.ok(shots.has(primary), primary);
  assert.ok(explosion);
  assert.ok(deaths);
});

void test('malformed wire input closes the browser socket using a permitted application code', async () => {
  const { Connection } = await import('../../src/network/connection');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  let code = 0,
    invalid = false;
  class FakeSocket extends EventTarget {
    static instance: FakeSocket;
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    constructor() {
      super();
      FakeSocket.instance = this;
    }
    send() {}
    close(value: number) {
      assert.ok(value === 1000 || (value >= 3000 && value <= 4999));
      code = value;
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  let connection: InstanceType<typeof Connection> | undefined;
  try {
    connection = new Connection(new URL('ws://127.0.0.1/ws'), {
      message() {},
      closed() {},
      invalid() {
        invalid = true;
      },
      error() {},
    });
    FakeSocket.instance.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'snapshot', version: PROTOCOL + 1 }),
      }),
    );
    assert.ok(invalid);
    assert.equal(code, CLOSE.rejected);
  } finally {
    connection?.close();
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  }
});
