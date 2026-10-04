import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, stepPlayer } from '../../src/core/simulation';
import type { Input, Damageable, ShotGeometry } from '../../src/core/simulation';
import { createCollisionGrid } from '../../src/core/grid';
import { rayWall } from '../../src/core/geometry';
import type { Wall } from '../../src/core/geometry';
import { MOVEMENT, SMG } from '../../src/gameconfig/tuning';

// Synthetic geometry, with no import of the practice scenario or concrete arena.
const geometry: ShotGeometry = Object.freeze({
  muzzleOffset: 0,
  muzzleSide: 0,
  muzzleHeight: 0.25,
  maxDistance: 50,
  wallHeight: 0.7,
});
const dt = 1 / 120;
const idle = (): Input => ({ x: 0, y: 0, aim: { x: 30, y: 0 }, fire: false });
function fixture(
  walls: readonly Wall[] = [],
  bodies: Damageable[] = [],
  seed = 7291,
  collisionWalls = walls,
) {
  return {
    player: createPlayer({ x: 0, y: 0 }, 0),
    environment: {
      walls,
      grid: createCollisionGrid({ x: -64, y: -64, w: 128, h: 128 }, collisionWalls),
    },
    bodies,
    random: { seed },
  };
}
type Fixture = ReturnType<typeof fixture>;
function tick(state: Fixture, input = idle(), step = dt, shape = geometry) {
  return stepPlayer(
    state.player,
    input,
    step,
    state.environment,
    state.bodies,
    state.random,
    shape,
  );
}
function advance(state: Fixture, seconds: number, input = idle()) {
  const shots = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const shot = tick(state, input);
    if (shot) shots.push(shot);
  }
  return shots;
}
const body = (id: number, x: number, hp = 100): Damageable => ({ id, x, y: 0, hp, radius: 0.25 });

void test('movement integrates old velocity, accelerates, caps speed and stops without negative drag', () => {
  const state = fixture(),
    input = { ...idle(), x: 1 };
  tick(state, input);
  assert.equal(state.player.x, 0);
  assert.ok(Math.abs(state.player.vx - 12.5 / 120) < 1e-9);
  advance(state, 1, input);
  assert.ok(Math.abs(state.player.vx - 3.25) < 1e-9);
  advance(state, 1);
  assert.equal(state.player.vx, 0);
  assert.equal(state.player.vy, 0);
});

void test('diagonal acceleration is stronger but has the same speed cap', () => {
  const axis = fixture(),
    diagonal = fixture();
  tick(axis, { ...idle(), x: 1 });
  tick(diagonal, { ...idle(), x: 1, y: 1 });
  assert.ok(Math.hypot(diagonal.player.vx, diagonal.player.vy) > axis.player.vx);
  advance(diagonal, 1, { ...idle(), x: 1, y: 1 });
  assert.ok(Math.abs(Math.hypot(diagonal.player.vx, diagonal.player.vy) - 3.25) < 1e-9);
});

void test('fixed-step input replay agrees under 30, 60 and 144 FPS schedules', () => {
  function replay(fps: number) {
    const state = fixture();
    let debt = 0,
      ticks = 0;
    const shots = [];
    for (let f = 0; f < fps * 4; f++) {
      debt += 1 / fps;
      while (debt + 1e-10 >= dt) {
        const shot = tick(state, {
          ...idle(),
          x: ticks < 120 ? 1 : ticks < 300 ? -1 : 0,
          y: ticks > 180 ? 1 : 0,
          fire: ticks > 200,
        });
        if (shot) shots.push(shot);
        ticks++;
        debt -= dt;
      }
    }
    return { state, shots };
  }
  assert.deepEqual(replay(30), replay(60));
  assert.deepEqual(replay(60), replay(144));
});

void test('caller-supplied timestep controls movement without a hidden practice clock', () => {
  for (const step of [1 / 60, 1 / 120]) {
    const state = fixture();
    state.player.vx = 2;
    tick(state, idle(), step);
    assert.equal(state.player.x, 2 * step);
    assert.equal(state.player.vx, 2 - 4 * step);
  }
});

void test('only supplied walls constrain movement, including under sustained input', () => {
  const walls = Object.freeze([Object.freeze({ x: 5, y: -10, w: 1, h: 20 })]);
  const blocked = fixture(walls),
    empty = fixture();
  advance(blocked, 4, { ...idle(), x: 1 });
  advance(empty, 4, { ...idle(), x: 1 });
  assert.ok(blocked.player.x <= 4.75);
  assert.ok(empty.player.x > 6);
});

void test('SMG equip delay, rate, recoil and spread recovery use reference parameters', () => {
  const state = fixture(),
    input = { ...idle(), fire: true };
  assert.equal(advance(state, 0.9, input).length, 0);
  assert.equal(advance(state, 0.1, input).length, 1);
  assert.ok(state.player.vx < 0);
  assert.equal(advance(state, 1, input).length, 10);
  assert.ok(state.player.spread <= 8);
  advance(state, 1);
  assert.equal(state.player.spread, 1);
});

void test('rays handle parallel directions and origins inside cover', () => {
  const wall = { x: 5, y: 5, w: 2, h: 2 };
  assert.equal(rayWall({ x: 2, y: 6 }, { x: 1, y: 0 }, wall), 3);
  assert.equal(rayWall({ x: 2, y: 4 }, { x: 1, y: 0 }, wall), Infinity);
  assert.equal(rayWall({ x: 6, y: 6 }, { x: 1, y: 0 }, wall), 0);
});

void test('SMG hits the nearest live body independent of body-list order', () => {
  const far = body(8, 3),
    dead = body(4, 0.5, 0),
    near = body(23, 1);
  const state = fixture([], [far, dead, near]);
  state.player.cooldown = 0;
  const shot = tick(state, { ...idle(), fire: true });
  assert.equal(shot?.targetId, 23);
  assert.equal(near.hp, 90);
  assert.equal(far.hp, 100);
  assert.equal(dead.hp, 0);
});

void test('turn and fire uses the old direction for muzzle, impact and recoil, then updates aim', () => {
  const east = body(1, 1),
    north = { ...body(2, 0), y: 1 };
  const state = fixture([], [east, north]);
  state.player.cooldown = 0;
  const shot = tick(state, { ...idle(), aim: { x: 0, y: 1 }, fire: true }, dt, {
    ...geometry,
    muzzleOffset: 0.4,
  });
  assert.equal(shot?.from.x, 0.4);
  assert.equal(shot?.from.y, 0);
  assert.equal(shot?.targetId, east.id);
  assert.equal(east.hp, 90);
  assert.equal(north.hp, 100);
  assert.equal(state.player.vx, -0.5);
  assert.equal(state.player.vy, 0);
  assert.equal(state.player.angle, Math.PI / 2);
});

void test('lethal damage is clamped and the core does not respawn a dead body', () => {
  const target = body(7, 1, 5),
    state = fixture([], [target]);
  state.player.cooldown = 0;
  const shot = tick(state, { ...idle(), fire: true });
  assert.equal(shot?.killed, true);
  assert.equal(target.hp, 0);
  assert.equal(
    advance(state, 4, { ...idle(), fire: true }).some((shot) => shot.hit),
    false,
  );
  assert.equal(target.hp, 0);
});

void test('supplied cover and blocked muzzle prevent damage', () => {
  for (const wallX of [0.02, 0.5]) {
    const target = body(2, 1),
      state = fixture([{ x: wallX, y: -1, w: 0.1, h: 2 }], [target], 7291, []);
    state.player.cooldown = 0;
    assert.equal(tick(state, { ...idle(), fire: true })?.hit, false);
    assert.equal(target.hp, 100);
  }
});

void test('explicit shot geometry controls muzzle position and reach', () => {
  const target = body(1, 2),
    state = fixture([], [target]);
  state.player.cooldown = 0;
  const shape = { ...geometry, muzzleOffset: 0.4, maxDistance: 0.5 };
  const shot = tick(state, { ...idle(), fire: true }, dt, shape)!;
  assert.equal(shot.from.x, 0.4);
  assert.equal(shot.from.y, 0);
  assert.ok(Math.hypot(shot.to.x - shot.from.x, shot.to.y - shot.from.y) <= 0.5);
  assert.equal(target.hp, 100);
});

void test('spread uses the supplied seed and remains reproducible after state restoration', () => {
  const first = fixture(),
    different = fixture([], [], 17);
  const seed = first.random.seed;
  advance(first, 0.2);
  assert.equal(first.random.seed, seed);
  const restored = structuredClone(first);
  const input = { ...idle(), fire: true };
  const shots = advance(first, 2, input);
  assert.deepEqual(shots, advance(restored, 2, input));
  assert.deepEqual(first, restored);
  assert.notDeepEqual(shots, advance(different, 2, input));
  assert.notEqual(first.random.seed, seed);
});

void test('recoil participates in the same final speed cap as movement', () => {
  const state = fixture();
  state.player.cooldown = 0;
  state.player.vx = -SMG.recoil - MOVEMENT.maxSpeed;
  tick(state, { ...idle(), fire: true, x: -1 });
  assert.ok(Math.abs(Math.hypot(state.player.vx, state.player.vy) - MOVEMENT.maxSpeed) < 1e-9);
});
