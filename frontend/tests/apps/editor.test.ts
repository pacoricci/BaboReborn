import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCollisionGrid } from '../../src/core/grid';
import {
  EditorHistory,
  compactWalls,
  exportMap,
  inspectMap,
  mirrorCells,
  newMap,
  paint,
  parseMap,
  resizeMap,
  strokeCells,
} from '../../src/apps/editor/model';
import { createMapTrial } from '../../src/apps/editor/play-world';
import type { ArenaMap } from '../../src/maps/types';
import { themes, bundledCatalog } from '../support/content';
const MAP_THEMES = themes.map((t) => t.id);

void test('scenario survives export, resize, painting and history without changing collisions', () => {
  const original = newMap(16, 24);
  const history = new EditorHistory(original);
  for (const theme of MAP_THEMES) {
    const themed = { ...original, theme };
    assert.deepEqual(parseMap(exportMap(themed)), themed);
    const resized = resizeMap(themed, 24, 24);
    assert.equal(paint(resized, { x: 5, y: 5 }, 'wall', 2, 'none').theme, theme);
    history.change(themed);
    history.finish();
    history.undo();
    history.redo();
    assert.equal(history.current.theme, theme);
    assert.deepEqual(history.current.walls, original.walls);
    assert.deepEqual(history.current.spawns, original.spawns);
  }
  for (const theme of ['', null, 12, '../texture.png'])
    assert.throws(() => parseMap(JSON.stringify({ ...original, theme })));
});

void test('editor round trips DM maps and refuses built-in team maps without dropping metadata', () => {
  const authored = newMap(16, 24);
  assert.deepEqual(parseMap(exportMap(authored)), authored);
  for (const entry of bundledCatalog.maps) {
    const source = readFileSync(`content/maps/${entry.id}.json`, 'utf8');
    if (entry.ctf) {
      assert.throws(() => parseMap(source), /Deathmatch/);
      continue;
    }
    const map = parseMap(source);
    assert.deepEqual(parseMap(exportMap(map)), map);
    assert.equal(inspectMap(map).regions, 1);
    assert.deepEqual(inspectMap(map).errors, []);
  }
});
void test('file import rejects unknown fields, invalid geometry and oversized UTF-8 input', () => {
  const map = newMap(16, 32);
  for (const invalid of [
    { ...map, extra: true },
    { ...map, schema: 99 },
    { ...map, width: 129 },
    { ...map, spawns: [{ x: 0, y: 0 }] },
    { ...map, walls: [{ x: 2, y: 2, w: 1, h: 1, height: null }] },
    { ...map, walls: [{ x: 2, y: 2, w: 1, h: 1, extra: true }] },
    { ...map, spawns: [{ x: 5, y: 5, extra: true }] },
  ])
    assert.throws(() => parseMap(JSON.stringify(invalid)));
  assert.throws(() => parseMap('not json'), /JSON/);
  assert.throws(() => parseMap(JSON.stringify(map) + JSON.stringify(map)), /JSON/);
  assert.throws(() => parseMap('é'.repeat(524289)), /1 MiB/);
});
void test('cell painting splits rectangles, preserves heights and applies rectangular symmetry', () => {
  const base = newMap(16, 32);
  const map = { ...base, walls: [...base.walls, { x: 4, y: 4, w: 4, h: 4, height: 4.5 }] };
  const result = paint(map, { x: 5, y: 5 }, 'floor', 3, 'none');
  const grid = createCollisionGrid({ x: 0, y: 0, w: 16, h: 32 }, result.walls);
  for (let y = 4; y < 8; y++)
    for (let x = 4; x < 8; x++) assert.equal(grid.cells[y * 16 + x], x === 5 && y === 5 ? 0 : 1);
  assert.equal(
    result.walls.filter((w) => w.height === 4.5).reduce((sum, w) => sum + w.w * w.h, 0),
    15,
  );
  const mirrored = paint(base, { x: 4, y: 5 }, 'wall', 5, 'both');
  assert.deepEqual(
    mirrored.walls.slice(-4).map((w) => [w.x, w.y, w.height]),
    [
      [4, 5, 5],
      [4, 26, 5],
      [11, 5, 5],
      [11, 26, 5],
    ],
  );
  assert.equal(mirrorCells(newMap(9, 9), { x: 4, y: 4 }, 'both').length, 1);
  assert.throws(() => paint(base, { x: 2, y: 3 }, 'wall', 6, 'none'));
});
void test('a continuous stroke is one undo and redo preserves later branches correctly', () => {
  const history = new EditorHistory(compactWalls(newMap()));
  const before = history.current;
  history.begin();
  for (const point of strokeCells({ x: 6, y: 8 }, { x: 16, y: 8 }))
    history.change(paint(history.current, point, 'wall', 2, 'none'));
  history.finish();
  const after = history.current;
  assert.ok(after.walls.some((w) => w.x === 6 && w.y === 8 && w.w === 11 && w.height === 2));
  history.undo();
  assert.deepEqual(history.current, before);
  assert.equal(history.canUndo, false);
  history.redo();
  assert.deepEqual(history.current, after);
  history.undo();
  history.change(paint(history.current, { x: 8, y: 9 }, 'spawn', 1, 'none'));
  history.finish();
  assert.equal(history.canRedo, false);
});

void test('painting unchanged floor does not consume history or replace the draft', () => {
  const map = newMap();
  const history = new EditorHistory(map);
  history.change(paint(map, { x: 8, y: 8 }, 'floor', 3, 'none'));
  history.finish();
  assert.equal(history.canUndo, false);
  assert.equal(history.current, map);
});
void test('erase removes fractional spawns while floor leaves them available for repair', () => {
  const map = { ...newMap(), spawns: [{ x: 5.3, y: 5.7 }] };
  const blocked = paint(map, { x: 5, y: 5 }, 'wall', 2, 'none');
  assert.match(inspectMap(blocked).errors.join(), /Spawn 1/);
  assert.throws(() => exportMap(blocked));
  const repaired = paint(blocked, { x: 5, y: 5 }, 'floor', 2, 'none');
  assert.deepEqual(repaired.spawns, map.spawns);
  assert.equal(inspectMap(repaired).errors.length, 0);
  const erased = paint(blocked, { x: 5, y: 5 }, 'erase', 2, 'none');
  assert.equal(erased.spawns.length, 0);
  assert.throws(() => exportMap(erased), /spawn/);
});
void test('resize clips old border, preserves heights and reports cropped spawns without deleting them', () => {
  const map = paint(newMap(16, 32), { x: 6, y: 6 }, 'wall', 5, 'none');
  const smaller = resizeMap(map, 8, 12);
  assert.deepEqual(smaller.spawns, map.spawns);
  assert.ok(smaller.walls.some((w) => w.height === 5));
  assert.match(inspectMap(smaller).errors.join(), /Spawn 2/);
  assert.ok(smaller.walls.every((w) => w.x + w.w <= 8 && w.y + w.h <= 12));
  const larger = resizeMap(map, 20, 40);
  assert.deepEqual(inspectMap(larger).errors, []);
  assert.equal(
    larger.walls.some((w) => w.x === 15 && w.h > 1),
    false,
  );
  assert.throws(() => resizeMap(map, 7, 32));
});
void test('connectivity finds sealed regions and open boundaries without conflating them with schema errors', () => {
  let map = newMap(16, 16);
  for (let y = 1; y < 15; y++) map = paint(map, { x: 8, y }, 'wall', 3, 'none');
  const report = inspectMap(map);
  assert.equal(report.regions, 2);
  assert.equal(report.unreachable.length, 6 * 14);
  assert.deepEqual(report.errors, []);
  assert.match(report.warnings.join(), /separate floor/);
  map = paint(map, { x: 8, y: 8 }, 'floor', 3, 'none');
  assert.equal(inspectMap(map).regions, 1);
  const open = paint(map, { x: 0, y: 6 }, 'floor', 3, 'none');
  assert.match(inspectMap(open).warnings.join(), /perimeter/);
});
void test('local map trial uses authored spawns and real collision and wall-height ballistics', () => {
  const map: ArenaMap = { ...newMap(16, 16), spawns: [{ x: 3.5, y: 4.5 }] };
  const trial = createMapTrial(map);
  assert.equal(trial.player.x, 3.5);
  for (let tick = 0; tick < 600; tick++)
    trial.step({ x: -1, y: 0, fire: false, aim: { x: 0, y: 4.5 } });
  assert.ok(trial.player.x >= 1.29 && trial.player.x < 1.7);
  const shot = (() => {
    for (let tick = 0; tick < 240; tick++) {
      const result = trial.step({ x: 0, y: 0, fire: true, aim: { x: 0, y: 4.5 } });
      if (result) return result;
    }
    return null;
  })();
  assert.ok(shot);
  assert.ok(shot.to.x <= 1.01);
  assert.throws(() => createMapTrial(map, 4), /spawn/);
});
