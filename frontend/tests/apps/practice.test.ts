import test from 'node:test';
import assert from 'node:assert/strict';
import { createPractice, stepPractice } from '../../src/apps/practice/simulation';
import type { PracticeWorld } from '../../src/apps/practice/simulation';
import { DEFAULT_PRACTICE } from '../../src/apps/practice/config';
import { TICK_SECONDS } from '../../src/core/timing';
import { createPracticeView, updatePracticeView } from '../../src/apps/practice/view';
import type { Input } from '../../src/core/simulation';
import { MOVEMENT } from '../../src/gameconfig/tuning';

const idle = (): Input => ({ x: 0, y: 0, aim: { x: 30, y: 9 }, fire: false });
function advance(world: PracticeWorld, seconds: number, input = idle()) {
  for (let i = 0; i < Math.round(seconds / TICK_SECONDS); i++)
    stepPractice(world, input, TICK_SECONDS);
}

void test('practice owns target scoring, feedback and its configurable respawn', () => {
  const world = createPractice({
    ...DEFAULT_PRACTICE,
    targetHealth: 10,
    respawnSeconds: 0.5,
    startAngle: 0,
    targets: [{ x: 19, y: 9 }],
  });
  world.movingTargets = false;
  world.player.cooldown = 0;
  stepPractice(world, { ...idle(), aim: { x: 19, y: 9 }, fire: true }, TICK_SECONDS);
  assert.equal(world.shots, 1);
  assert.equal(world.hits, 1);
  assert.equal(world.eliminations, 1);
  assert.equal(world.targets[0]!.hp, 0);
  assert.equal(world.targets[0]!.flash, world.config.flashSeconds);
  advance(world, 0.4);
  assert.equal(world.targets[0]!.hp, 0);
  advance(world, 0.2);
  assert.equal(world.targets[0]!.hp, 10);
  assert.equal(world.targets[0]!.respawn, 0);
  assert.equal(world.eliminations, 1);
});

void test('practice accepts a different arena, placement and an empty target scenario', () => {
  const world = createPractice({
    ...DEFAULT_PRACTICE,
    arena: {
      name: 'Empty',
      schema: 1,
      theme: 'classic',
      id: 'synthetic',
      author: 'Tests',
      width: 20,
      height: 20,
      walls: [],
      spawns: [],
    },
    start: { x: 3, y: 4 },
    targets: [],
  });
  world.movingTargets = false;
  advance(world, 3, { ...idle(), x: 1 });
  assert.ok(world.player.x > 10);
  assert.equal(world.player.y, 4);
  assert.equal(world.targets.length, 0);
});

void test('practice reuses its compiled collision grid while moving along cover', () => {
  const world = createPractice({
    ...DEFAULT_PRACTICE,
    start: { x: 4.72, y: 4 },
    targets: [],
    arena: {
      name: 'Grid corridor',
      schema: 1,
      theme: 'classic',
      id: 'synthetic',
      author: 'Tests',
      width: 16,
      height: 16,
      walls: [{ x: 5, y: 1, w: 1, h: 13 }],
      spawns: [],
    },
  });
  const geometry = world.geometry,
    cells = geometry.grid.cells,
    before = structuredClone(geometry.grid);
  advance(world, 2, { ...idle(), y: 1 });
  assert.equal(world.player.x, 4.7);
  assert.ok(world.player.y > 9);
  assert.equal(world.geometry, geometry);
  assert.equal(world.geometry.grid.cells, cells);
  assert.deepEqual(world.geometry.grid, before);
});

void test('new practice sessions reset mutable state without changing configuration or each other', () => {
  const config = structuredClone(DEFAULT_PRACTICE),
    baseline = structuredClone(config);
  const first = createPractice(config),
    second = createPractice(config);
  advance(first, 2, { ...idle(), fire: true, x: 1 });
  assert.equal(second.time, 0);
  assert.equal(second.shots, 0);
  assert.equal(second.random.seed, config.seed);
  assert.deepEqual(config, baseline);
  assert.deepEqual(createPractice(config), second);
});

void test('all twelve map spawns and practice motion paths stay clear of cover', () => {
  const config = DEFAULT_PRACTICE;
  assert.equal(config.arena.spawns.length, 12);
  const positions = [
    ...config.arena.spawns,
    ...config.targets.flatMap((p) =>
      [-config.motionAmplitude, 0, config.motionAmplitude].map((d) => ({ x: p.x + d, y: p.y })),
    ),
  ];
  for (const point of positions)
    for (const wall of config.arena.walls) {
      const dx = point.x - Math.max(wall.x, Math.min(wall.x + wall.w, point.x));
      const dy = point.y - Math.max(wall.y, Math.min(wall.y + wall.h, point.y));
      assert.ok(Math.hypot(dx, dy) >= MOVEMENT.radius, `blocked point ${point.x},${point.y}`);
    }
});

void test('view adapter maps health and feedback without exposing mutable simulation state', () => {
  const world = createPractice(),
    view = createPracticeView(world);
  const actors = view.actors,
    actor = actors[0]!;
  world.targets[0]!.hp = 50;
  world.targets[0]!.flash = 0.1;
  const displayed = { x: world.player.x - 0.2, y: world.player.y, angle: world.player.angle };
  updatePracticeView(view, world, displayed);
  assert.equal(view.player.x, displayed.x);
  assert.notEqual(view.player.x, world.player.x);
  assert.equal(view.actors[0]!.healthFraction, 0.5);
  assert.equal(view.actors[0]!.hitFlash, true);
  assert.equal(view.actors, actors);
  assert.equal(view.actors[0]!, actor);
  view.player.x = -10;
  view.actors[0].x = -20;
  assert.notEqual(world.player.x, -10);
  assert.notEqual(world.targets[0]!.x, -20);
  world.targets[0]!.hp = 0;
  updatePracticeView(view, world, world.player);
  assert.equal(view.actors[0].visible, false);
});

void test('practice uses ordinary equipment with independent state for every session', () => {
  const first = createPractice(),
    second = createPractice();
  assert.equal(first.player.equipment.primary, 'smg');
  assert.equal(first.player.equipment.secondary, 'knives');
  assert.equal(first.player.equipment.grenades, 2);
  first.player.equipment.grenades = 0;
  assert.equal(second.player.equipment.grenades, 2);
});
