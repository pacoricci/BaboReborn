import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionGrid, resolveGrid } from '../../src/core/grid';
import { MOVEMENT } from '../../src/gameconfig/tuning';

const bounds = { x: 0, y: 0, w: 16, h: 16 };

void test('grid compilation preserves the union of whole cells and rejects fractional movement walls', () => {
  const merged = createCollisionGrid(bounds, [{ x: 5, y: 4, w: 1, h: 2 }]);
  const split = createCollisionGrid(bounds, [
    { x: 5, y: 5, w: 1, h: 1 },
    { x: 5, y: 4, w: 1, h: 1 },
    { x: 5, y: 4, w: 1, h: 1 },
  ]);
  assert.deepEqual(merged, split);
  assert.equal(merged.cells[4 * 16 + 5], 1);
  assert.equal(merged.cells[4 * 16 + 6], 0);
  assert.throws(() => createCollisionGrid(bounds, [{ x: 5.1, y: 4, w: 1, h: 1 }]), /whole cells/);
  assert.throws(() => createCollisionGrid(bounds, [{ x: 15, y: 4, w: 2, h: 1 }]), /inside/);
  assert.throws(() => createCollisionGrid({ ...bounds, w: 2 }, []), /at least 3/);
});

void test('collision borrows occupancy without mutation and supports translated grid bounds', () => {
  const grid = createCollisionGrid({ x: -8, y: -8, w: 16, h: 16 }, [{ x: -3, y: -4, w: 1, h: 1 }]);
  const cells = grid.cells,
    before = structuredClone(grid);
  const p = { x: -3.2, y: -3.5, vx: 0.6, vy: 0 };
  resolveGrid(p, -3.3, -3.5, grid, MOVEMENT.radius, MOVEMENT.bounce, MOVEMENT.clearance);
  assert.equal(p.x, -3.3);
  assert.equal(p.vx, -0.27);
  assert.equal(grid.cells, cells);
  assert.deepEqual(grid, before);
});

void test('out-of-bounds recovery stays finite and never reads an invalid cell index', () => {
  const grid = createCollisionGrid(bounds, []);
  const guardedCells = new Proxy(grid.cells, {
    get(target, key) {
      const index = Number(key);
      if (Number.isInteger(index))
        assert.ok(index >= 0 && index < target.length, `invalid read ${index}`);
      return Reflect.get(target, key) as unknown;
    },
  });
  for (const position of [-100, 100]) {
    const p = { x: position, y: position, vx: 0, vy: 0 };
    resolveGrid(p, position, position, { ...grid, cells: guardedCells }, 0.25, 0.45, 0.05);
    assert.ok(p.x >= 1.3 && p.x <= 14.7 && p.y >= 1.3 && p.y <= 14.7);
  }
});
