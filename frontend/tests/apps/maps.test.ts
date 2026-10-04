import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { isArenaMap } from '../../src/maps/validation';
import type { ArenaMap } from '../../src/maps/types';
import { YARD } from '../../src/maps/yard';
import { parseServerMessage } from '../../src/network/protocol';
import { OnlineSession } from '../../src/apps/match/session';
import { OnlineView } from '../../src/apps/match/view';
import { welcome, snap } from '../support/online';
import { mapImpact } from '../../src/core/ballistics';
import { cameraTarget, CAMERA } from '../../src/presentation/camera';

const crossing: unknown = JSON.parse(readFileSync('content/maps/crossing.json', 'utf8'));
void test('practice consumes the validated authored Yard without changing its schema or decals', () => {
  const authored: unknown = JSON.parse(readFileSync('content/maps/yard.json', 'utf8'));
  assert.ok(isArenaMap(YARD));
  assert.deepEqual(YARD, authored);
});
void test('authored spawns stay visible below tall walls with the clamped game camera', () => {
  for (const id of [
    'ion-foundry',
    'thorn-chapel',
    'neon-divide',
    'broadside',
    'crownfall',
    'neon-relay',
    'cryo-lab',
  ]) {
    const map: unknown = JSON.parse(readFileSync(`content/maps/${id}.json`, 'utf8'));
    assert.ok(isArenaMap(map));
    for (const spawn of map.spawns) {
      // Perimeter camera clamping can hide an otherwise clear spawn behind a tall tower.
      for (const offset of [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 },
      ]) {
        const aim = { x: spawn.x + offset.x, y: spawn.y + offset.y };
        const camera = cameraTarget(spawn, aim, map.width, map.height);
        const ray = mapImpact(
          { ...camera, z: CAMERA.height },
          { ...spawn, z: 0.25 },
          map.walls,
          0.7,
        );
        assert.equal(ray.normal, null, `${id}: spawn ${spawn.x}, ${spawn.y} is hidden`);
      }
    }
  }
});
void test('authored maps validate and reject unsafe geometry before allocation', () => {
  for (const file of readdirSync('content/maps').filter((name) => name.endsWith('.json'))) {
    const data: unknown = JSON.parse(readFileSync(`content/maps/${file}`, 'utf8'));
    assert.ok(isArenaMap(data), file);
    assert.ok(data.teams, `${file} must support CTF`);
  }
  assert.ok(isArenaMap(crossing));
  for (const patch of [
    { schema: 2 },
    { id: '../escape' },
    { width: Infinity },
    { height: 129 },
    { spawns: [] },
    { spawns: [{ x: 1.1, y: 4 }] },
    { spawns: [{ x: 8.5, y: 6 }] },
    { walls: [{ x: 27, y: 2, w: 2, h: 1 }] },
  ])
    assert.equal(isArenaMap({ ...crossing, ...patch }), false);
});
void test('map transition clears prediction, batches and interpolation; rectangular camera uses new bounds', () => {
  assert.ok(isArenaMap(crossing));
  const old = new OnlineSession(welcome);
  old.receive(snap(1), 0, 8);
  old.advance({ x: 1, y: 0, fire: true, aim: { x: 12, y: 4 } }, 0.025, 25, true, () => {});
  assert.ok(old.prediction.pending.length > 0);
  const change = {
    ...welcome,
    type: 'map' as const,
    round: 2,
    arena: { ...crossing, theme: 'cyberpunk' as const },
  };
  assert.deepEqual(parseServerMessage(JSON.stringify(change)), change);
  const next = new OnlineSession(change);
  assert.equal(next.batch(100), null);
  assert.equal(next.prediction.pending.length, 0);
  assert.equal(next.interpolation.players(100, 120).length, 0);
  assert.equal(next.prediction.geometry.grid?.w, 28);
  assert.equal(next.prediction.geometry.grid?.h, 20);
  const snapshot = snap(1200);
  snapshot.match.round = 2;
  snapshot.players[0]!.status = 'spectator';
  next.receive(snapshot, 100, snapshot.capturedAtMs);
  const view = new OnlineView();
  view.reset(28, 20);
  const result = view.compose(next, { x: 4, y: 4 }, 110, 0.01, true, 0, 0);
  assert.deepEqual(result.camera?.target, { x: 14, y: 10 });
  assert.throws(() => parseServerMessage(JSON.stringify({ ...change, round: 0 })));
  assert.throws(() =>
    parseServerMessage(JSON.stringify({ ...change, arena: { ...crossing, width: 2 } })),
  );
});

void test('camera clamps independently on a rectangular map', async () => {
  const { cameraTarget } = await import('../../src/presentation/camera');
  const a = crossing as ArenaMap;
  const target = cameraTarget({ x: 100, y: 100 }, { x: 100, y: 100 }, a.width, a.height);
  assert.ok(target.x < 28 && target.y < 20 && target.x > target.y);
});
