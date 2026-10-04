import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, stepPlayer } from '../../src/core/simulation';
import type { Input } from '../../src/core/simulation';
import { createEquipment } from '../../src/core/equipment';
import type { Primary, Secondary } from '../../src/core/equipment';
import { createCollisionGrid } from '../../src/core/grid';
import { SMG_MUZZLE } from '../../src/gameconfig/tuning';
const geometry = {
  muzzleOffset: SMG_MUZZLE.forward,
  muzzleSide: SMG_MUZZLE.right,
  muzzleHeight: SMG_MUZZLE.height,
  maxDistance: 128,
  wallHeight: 0.7,
};
const world = { walls: [], grid: createCollisionGrid({ x: 0, y: 0, w: 36, h: 36 }, []) };
const idle: Input = { x: 0, y: 0, aim: { x: 30, y: 18 }, fire: false };
function equipped(primary: Primary = 'smg', secondary: Secondary = 'knives') {
  return { ...createPlayer({ x: 18, y: 18 }, 0), equipment: createEquipment(primary, secondary) };
}
void test('Shotgun emits five pellets, recoils once and reloads after six shots', () => {
  const p = equipped('shotgun');
  const random = { seed: 7291 };
  p.cooldown = 0;
  let count = 0,
    reloadTick = -1;
  for (let tick = 0; tick < 900; tick++) {
    const result = stepPlayer(p, { ...idle, fire: true }, 1 / 120, world, [], random, geometry);
    if (!result) continue;
    count++;
    assert.equal(result.pellets?.length, 5);
    if (count === 1) {
      assert.equal(p.vx, -3);
      assert.equal(p.cooldown, 0.85);
    }
    if (count === 6) {
      assert.equal(p.cooldown, 3);
      assert.equal(p.equipment.shells, 6);
      reloadTick = tick;
    }
    if (count === 7) {
      assert.equal(tick - reloadTick, 360);
      assert.equal(p.equipment.shells, 1);
      break;
    }
  }
  assert.equal(count, 7);
});
void test('action precedence preserves grenade restrictions and the original Molotov melee exception', () => {
  const p = equipped('smg', 'shield'),
    random = { seed: 1 };
  p.cooldown = 0;
  stepPlayer(
    p,
    { ...idle, secondary: true, grenade: true, molotov: true },
    1 / 120,
    world,
    [],
    random,
    geometry,
  );
  assert.equal(p.equipment.secondaryActivated, true);
  assert.equal(p.equipment.protection, 2);
  assert.equal(p.equipment.meleeDelay, 2.5);
  assert.equal(p.equipment.action, 'molotov');
  assert.equal(p.equipment.grenades, 2);
  assert.equal(p.equipment.molotovs, 0);
  assert.equal(p.vx, 1);
  assert.equal(stepPlayer(p, { ...idle, fire: true }, 1 / 120, world, [], random, geometry), null);
  for (let i = 0; i < 300; i++) stepPlayer(p, idle, 1 / 120, world, [], random, geometry);
  stepPlayer(p, { ...idle, grenade: true }, 1 / 120, world, [], random, geometry);
  assert.equal(p.equipment.grenades, 1);
});
void test('authored arena connects all twelve spawns through traversable cell centers', async () => {
  const { readFileSync } = await import('node:fs');
  const arena = JSON.parse(
    readFileSync(new URL('../../../content/maps/yard.json', import.meta.url), 'utf8'),
  ) as {
    width: number;
    height: number;
    walls: { x: number; y: number; w: number; h: number }[];
    spawns: { x: number; y: number }[];
  };
  assert.equal(arena.spawns.length, 12);
  const grid = createCollisionGrid({ x: 0, y: 0, w: arena.width, h: arena.height }, arena.walls);
  const start = arena.spawns[0]!,
    queue = [Math.floor(start.y) * arena.width + Math.floor(start.x)],
    seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!,
      x = current % arena.width,
      y = Math.floor(current / arena.width);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx,
        ny = y + dy,
        key = ny * arena.width + nx;
      if (
        nx < 1 ||
        ny < 1 ||
        nx >= arena.width - 1 ||
        ny >= arena.height - 1 ||
        grid.cells[key] !== 0 ||
        seen.has(key)
      )
        continue;
      seen.add(key);
      queue.push(key);
    }
  }
  for (const spawn of arena.spawns)
    assert.ok(
      seen.has(Math.floor(spawn.y) * arena.width + Math.floor(spawn.x)),
      `Disconnected spawn ${spawn.x},${spawn.y}`,
    );
});
