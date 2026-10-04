import test from 'node:test';
import assert from 'node:assert/strict';
import { mapImpact, sphereImpact } from '../../src/core/ballistics';
import { SMG_MUZZLE } from '../../src/gameconfig/tuning';
import { CAMERA, followCamera } from '../../src/presentation/camera';
import { createPlayer, stepPlayer } from '../../src/core/simulation';
import { createCollisionGrid } from '../../src/core/grid';

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const wall = { x: 5, y: 4, w: 1, h: 1 };

void test('SMG attachment uses the verified flash1 coordinates', () => {
  near(SMG_MUZZLE.forward, 0.39787338256835936);
  near(SMG_MUZZLE.right, 0.16505887985229492);
  near(SMG_MUZZLE.height, 0.2486686134338379);
});

void test('far precise aim uses the lateral muzzle; near aim uses the player center with 3D threshold', () => {
  const world = { walls: [], grid: createCollisionGrid({ x: -16, y: -16, w: 32, h: 32 }, []) };
  const shape = {
    muzzleOffset: SMG_MUZZLE.forward,
    muzzleSide: SMG_MUZZLE.right,
    muzzleHeight: SMG_MUZZLE.height,
    wallHeight: 0.7,
    maxDistance: 128,
  };
  for (const [distance, angle] of [
    [1.47, 0],
    [1.49, Math.atan2(SMG_MUZZLE.right, 1.49 - SMG_MUZZLE.forward)],
    [10, Math.atan2(SMG_MUZZLE.right, 10 - SMG_MUZZLE.forward)],
  ] as const) {
    const player = createPlayer({ x: 0, y: 0 }, 0);
    stepPlayer(
      player,
      { x: 0, y: 0, aim: { x: distance, y: 0 }, fire: false },
      1 / 120,
      world,
      [],
      { seed: 1 },
      shape,
    );
    near(player.angle, angle);
  }
});

void test('finite wall side impact and muzzle clearance use the same intersection geometry', () => {
  const hit = mapImpact({ x: 4, y: 4.5, z: 0.25 }, { x: 8, y: 4.5, z: 0.25 }, [wall], 0.7);
  assert.deepEqual(hit.point, { x: 5, y: 4.5, z: 0.25 });
  assert.deepEqual(hit.normal, { x: -1, y: 0, z: 0 });
  const muzzle = mapImpact({ x: 4.7, y: 4.5, z: 0.25 }, { x: 5.1, y: 4.5, z: 0.25 }, [wall], 0.7);
  near(muzzle.point.x + muzzle.normal!.x * 0.01, 4.99);
});

void test('wall tops stop descending shots while high horizontal shots clear the wall', () => {
  const top = mapImpact({ x: 4, y: 4.5, z: 1.5 }, { x: 6, y: 4.5, z: 0.5 }, [wall], 0.7);
  near(top.point.x, 5.6);
  near(top.point.z, 0.7);
  assert.deepEqual(top.normal, { x: 0, y: 0, z: 1 });
  const high = mapImpact({ x: 4, y: 4.5, z: 0.8 }, { x: 7, y: 4.5, z: 0.8 }, [wall], 0.7);
  assert.equal(high.normal, null);
  assert.equal(high.point.x, 7);
});

void test('ground impact shortens a descending segment and finite segments do not reach distant cover', () => {
  assert.deepEqual(mapImpact({ x: 1, y: 1, z: 0.25 }, { x: 3, y: 1, z: -0.25 }, [], 0.7).point, {
    x: 2,
    y: 1,
    z: 0,
  });
  assert.equal(
    mapImpact({ x: 3, y: 4.5, z: 0.25 }, { x: 4, y: 4.5, z: 0.25 }, [wall], 0.7).normal,
    null,
  );
});

void test('sphere hit endpoint is the source closest-point projection, with tangent and height checks', () => {
  const from = { x: 0, y: 0, z: 0.25 },
    to = { x: 5, y: 0, z: 0.25 };
  assert.deepEqual(sphereImpact(from, to, { x: 2, y: 0, z: 0.25 }, 0.25), { x: 2, y: 0, z: 0.25 });
  assert.deepEqual(sphereImpact(from, to, { x: 2, y: 0.25, z: 0.25 }, 0.25), {
    x: 2,
    y: 0,
    z: 0.25,
  });
  assert.equal(sphereImpact(from, to, { x: 2, y: 0.251, z: 0.25 }, 0.25), null);
  assert.equal(
    sphereImpact({ ...from, z: 0.6 }, { ...to, z: 0.6 }, { x: 2, y: 0, z: 0.25 }, 0.25),
    null,
  );
});

void test('shortening the segment rejects a farther sphere whose radius does not overlap the endpoint', () => {
  assert.equal(
    sphereImpact({ x: 0, y: 0, z: 0.25 }, { x: 2, y: 0, z: 0.25 }, { x: 3, y: 0, z: 0.25 }, 0.25),
    null,
  );
});

void test('camera follows the source weights, edge limits and linear update coefficient', () => {
  const position = { x: 18, y: 9 };
  followCamera(position, { x: 18, y: 9 }, { x: 27, y: 18 }, 36, 1 / 60);
  near(position.x, 18 + 4 / 24);
  near(position.y, 9 + 4 / 24);
  const edge = { x: 18, y: 18 };
  followCamera(edge, { x: 0, y: 0 }, { x: 0, y: 0 }, 36, 0.1);
  assert.deepEqual(edge, { x: 14.75, y: 14.5 });
  assert.equal(CAMERA.aspect, 1.333);
  assert.equal(CAMERA.height, 7);
  near(2 * CAMERA.height * Math.tan(CAMERA.verticalFovRadians / 2), 8.08290376865476);
});
