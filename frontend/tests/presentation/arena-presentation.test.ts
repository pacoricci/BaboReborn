import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { ModelAssets } from '../../src/presentation/assets/model-assets';
import { ArenaActors } from '../../src/presentation/actors/arena-actors';
import { ArenaEffects } from '../../src/presentation/effects/arena-effects';
import { drawMinimap } from '../../src/presentation/ui/minimap';
import type { ArenaView, ShotView } from '../../src/presentation/view';
import { welcome } from '../support/online';

const shot: ShotView = {
  kind: 'smg',
  from: { x: 4, y: 4, z: 0.3 },
  to: { x: 8, y: 4, z: 0.3 },
  killed: false,
};

void test('transient meshes expire independently, reset removes live effects, and scene disposal owns materials', () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const effects = new ArenaEffects(scene);
    effects.shot(shot);
    const tracer = scene.getMeshByName('shot-tracer')!,
      spark = scene.getMeshByName('impact')!;
    effects.render(0.05);
    assert.equal(tracer.isDisposed(), true);
    assert.equal(spark.isDisposed(), false);
    assert.ok(Math.abs(spark.visibility - 0.07 / 0.12) < 1e-10);
    effects.shot({ ...shot, kind: 'photon' });
    effects.render(0.2);
    assert.equal(scene.getMeshByName('shot-tracer')!.isDisposed(), false);
    assert.equal(spark.isDisposed(), true);
    effects.explosion({ x: 6, y: 4, z: 0 }, 2);
    const ring = scene.getMeshByName('blast-ring')!;
    effects.render(0.1);
    assert.ok(ring.scaling.x > 0.25);
    effects.reset();
    assert.equal(scene.meshes.length, 0);
    effects.shot({ ...shot, kind: 'bazooka' });
    assert.equal(scene.meshes.length, 0, 'rocket launch has no instant tracer or impact');
    assert.ok(scene.materials.length > 0, 'materials remain shared for later effects');
    scene.dispose();
    assert.equal(scene.materials.length, 0);
  } finally {
    engine.dispose();
  }
});

void test('online armed actors and unarmed practice targets release meshes/materials on removal', async () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const models = new ModelAssets(scene, '', {}, async (kind) =>
      LoadAssetContainerAsync(
        new Uint8Array(
          await readFile(new URL(`../../public/assets/kit/models/${kind}.glb`, import.meta.url)),
        ),
        scene,
        { pluginExtension: '.glb' },
      ),
    );
    await models.ready;
    const bodies = new ArenaActors(
      scene,
      {
        models,
        flash: new StandardMaterial('flash', scene),
        skin: (name: string) => new StandardMaterial(`${name}-skin`, scene),
        setSkin: () => {},
      },
      () => {},
    );
    const view: ArenaView = {
      player: { x: 4, y: 4, angle: 0, life: 1 },
      actors: [],
    };
    bodies.render(view, 0.016, 0.016);
    const baseline = {
      meshes: scene.meshes.length,
      materials: scene.materials.length,
      nodes: scene.transformNodes.length,
    };
    const target = {
      id: 2,
      x: 6,
      y: 4,
      life: 1,
      visible: true,
      healthFraction: 0.5,
      hitFlash: false,
    };
    for (const actor of [target, { ...target, angle: 0 }]) {
      bodies.render({ ...view, actors: [actor] }, 0.016, 0.016);
      assert.equal(bodies.snapshot().actors.length, 1);
      const root = scene.getTransformNodeByName('actor-2')!;
      assert.equal(root.position.x, 6);
      assert.ok(scene.meshes.length > baseline.meshes);
      bodies.render(view, 0.016, 0.016);
      assert.equal(root.isDisposed(), true);
      assert.equal(bodies.snapshot().actors.length, 0);
      assert.deepEqual(
        {
          meshes: scene.meshes.length,
          materials: scene.materials.length,
          nodes: scene.transformNodes.length,
        },
        baseline,
      );
    }
    bodies.shot({ ...shot, kind: 'minibot' }, 1);
    assert.equal(bodies.snapshot().player.motion.kick, 0);
    bodies.shot(shot);
    bodies.render(view, 0.016, 0.016);
    bodies.render(view, 0.016, 0.016);
    assert.ok(bodies.snapshot().player.motion.kick > 0);
    bodies.reset();
    assert.equal(bodies.snapshot().player.motion.kick, 0);
  } finally {
    engine.dispose();
  }
});

void test('minimap projects rectangular maps, visible opponents and camera bounds without spawn markers', () => {
  const rectangles: number[][] = [],
    circles: number[][] = [],
    outlines: number[][] = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect(...args: number[]) {
      rectangles.push(args);
    },
    strokeRect(...args: number[]) {
      outlines.push(args);
    },
    arc(...args: number[]) {
      circles.push(args);
    },
    beginPath() {},
    fill() {},
  } as unknown as CanvasRenderingContext2D;
  drawMinimap(
    context,
    { ...welcome.arena, width: 40, height: 20, walls: [{ x: 2, y: 3, w: 4, h: 5 }] },
    {
      player: { x: 4, y: 4, angle: 0, visible: false },
      actors: [
        { id: 2, x: 10, y: 5, visible: true, healthFraction: 1, hitFlash: false },
        { id: 3, x: 15, y: 8, visible: false, healthFraction: 1, hitFlash: false },
      ],
    },
    { x: 8, y: 10, height: 7, fov: Math.PI / 2 },
  );
  assert.deepEqual(rectangles, [
    [0, 0, 216, 216],
    [10.8, 64.80000000000001, 21.6, 27],
  ]);
  assert.equal(
    circles.length,
    1,
    'one visible opponent; dead local player and spawn markers are omitted',
  );
  assert.deepEqual(circles[0]?.slice(0, 3), [54, 81, 2.6]);
  assert.equal(outlines.length, 1);
  assert.ok(Math.abs(outlines[0]![3]! - 75.6) < 1e-10);
});

void test('minimap opacity is independent of actor visibility and does not leak into objectives', () => {
  const alphas: number[] = [];
  const context = {
    globalAlpha: 1,
    fillRect() {
      assert.equal(context.globalAlpha, 1);
    },
    strokeRect() {},
    beginPath() {},
    arc() {},
    fill() {
      alphas.push(context.globalAlpha);
    },
  } as unknown as CanvasRenderingContext2D;
  drawMinimap(
    context,
    welcome.arena,
    {
      player: { x: 4, y: 4, angle: 0 },
      actors: [
        { id: 2, x: 4, y: 4, visible: true, minimapOpacity: 0, healthFraction: 1, hitFlash: false },
        {
          id: 3,
          x: 4,
          y: 4,
          visible: false,
          minimapOpacity: 0.5,
          healthFraction: 0,
          hitFlash: false,
        },
      ],
      objects: [{ id: 4, kind: 'flag-blue', x: 4, y: 4, z: 0 }],
    },
    { x: 4, y: 4, height: 7, fov: 1 },
  );
  assert.deepEqual(alphas, [0.5, 1]);
  assert.equal(context.globalAlpha, 1);
});
