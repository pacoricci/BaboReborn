import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { ModelAssets } from '../../src/presentation/assets/model-assets';
import { MODEL_NAMES } from '../../src/presentation/assets/model-catalog';
import { ArenaObjects } from '../../src/presentation/environment/arena-objects';
import type { WorldModel } from '../../src/presentation/environment/world-art';

async function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
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
  // Model readiness does not wait for the separately loaded cosmetic textures.
  for (const kind of MODEL_NAMES) assert.equal(models.status[`${kind}.glb`], 'ready', kind);
  const objects = new ArenaObjects(scene, {
    models,
    flash: new StandardMaterial('flash', scene),
  });
  return { engine, scene, objects };
}

void test('world objects retain identity, replace changed kinds and release removed instances without losing shared art', async () => {
  const { engine, scene, objects } = await fixture();
  try {
    const pickup = { id: 7, kind: 'smg', x: 4, y: 6, z: 0 };
    objects.render([pickup], 0);
    const original = scene.getTransformNodeByName('object-smg')!;
    objects.render([{ ...pickup, x: 8, z: 0.3 }], 0.016);
    assert.equal(scene.getTransformNodeByName('object-smg'), original);
    assert.deepEqual(original.position.asArray(), [8, 0.3, 6]);
    objects.render([{ ...pickup, kind: 'minibot' }], 0);
    assert.equal(original.isDisposed(), true);
    const device = scene.getTransformNodeByName('object-minibot')!;
    assert.deepEqual(
      objects.snapshot().map(({ id, kind }) => ({ id, kind })),
      [{ id: 7, kind: 'minibot' }],
    );
    objects.render([], 0);
    assert.equal(device.isDisposed(), true);
    assert.deepEqual(objects.snapshot(), []);
    const baseline = [scene.meshes.length, scene.transformNodes.length, scene.materials.length];
    for (let i = 0; i < 3; i++) {
      objects.render([pickup], 0);
      assert.equal(scene.getTransformNodeByName('object-smg')!.isDisposed(), false);
      objects.render([], 0);
      assert.deepEqual(
        [scene.meshes.length, scene.transformNodes.length, scene.materials.length],
        baseline,
        'repeated pickups reuse scene-owned templates and materials',
      );
    }
    objects.render([pickup], 0);
    scene.dispose();
    assert.equal(scene.meshes.length, 0);
    assert.equal(scene.materials.length, 0);
    assert.equal(scene.transformNodes.length, 0);
  } finally {
    engine.dispose();
  }
});

void test('device feedback consumes visual state without changing it or needing a camera or match', async () => {
  const { engine, scene, objects } = await fixture();
  try {
    const views = [
      { id: 1, kind: 'minibot', x: 2, y: 3, z: 0, angle: 1, turret: { angle: 0.4, shotAge: 0 } },
      { id: 3, kind: 'rocket', x: 4, y: 5, z: 0.5, angle: 0.2 },
      { id: 4, kind: 'flame', x: 5, y: 6, z: 0 },
    ];
    const before = structuredClone(views);
    objects.render(views, 0.1);
    assert.deepEqual(views, before);
    const bot = scene.getTransformNodeByName('object-minibot') as WorldModel;
    const rocket = scene.getTransformNodeByName('object-rocket')!;
    const flame = scene.getTransformNodeByName('object-flame')!;
    assert.equal(bot.rotation.y, 0, 'body aim does not rotate the device base');
    assert.equal(bot.position.y, 0.08);
    assert.equal(bot.turretHead!.rotation.y, Math.PI / 2 - 0.4);
    assert.equal(bot.muzzle!.isEnabled(), true);
    assert.equal(rocket.rotation.y, Math.PI / 2 - 0.2);
    const rotation = flame.rotation.y;
    objects.render(
      views.map((view) =>
        view.id === 1 ? { ...view, turret: { angle: 1, shotAge: 0.08 } } : view,
      ),
      0.1,
    );
    assert.equal(bot.muzzle!.isEnabled(), false, 'flash expires at the existing 80 ms boundary');
    assert.equal(bot.turretHead!.rotation.y, Math.PI / 2 - 1);
    assert.equal(flame.rotation.y, rotation, 'shader animates the fire without rotating its base');
    assert.equal(objects.snapshot().find(({ id }) => id === 1)!.muzzle, false);
  } finally {
    engine.dispose();
  }
});

void test('throwables tumble by projectile age, settle when stopped and keep static previews still', async () => {
  const { engine, scene, objects } = await fixture();
  try {
    const views = ['grenade', 'molotov'].map((kind, id) => ({
      id,
      kind,
      x: 4,
      y: 5,
      z: 0.5,
      angle: 0.4,
      throwMotion: { age: 0.25, moving: true },
    }));
    const before = structuredClone(views);
    objects.render(views, 1 / 30);
    const nodes = views.map(
      ({ kind }) => scene.getTransformNodeByName(`object-${kind}`) as WorldModel,
    );
    const rotations = nodes.map((node) => node.throwable!.rotationQuaternion!.clone());
    objects.render(views, 1 / 120);
    for (const [i, node] of nodes.entries()) {
      assert.deepEqual(
        node.throwable!.rotationQuaternion!.asArray(),
        rotations[i]!.asArray(),
        'equal projectile ages produce equal poses regardless of rendering time',
      );
      assert.deepEqual(node.position.asArray(), [4, 0.5, 5]);
      assert.equal(node.rotation.y, Math.PI / 2 - 0.4, 'trajectory aim remains on the parent');
    }
    objects.render(
      views.map((view) => ({ ...view, throwMotion: { age: 0.6, moving: true } })),
      0,
    );
    for (const [i, node] of nodes.entries())
      assert.notDeepEqual(node.throwable!.rotationQuaternion!.asArray(), rotations[i]!.asArray());
    const stopped = views.map((view) => ({
      ...view,
      z: 0.01,
      angle: 0,
      throwMotion: { age: 0.8, moving: false },
    }));
    const landing = nodes.map((node) => node.throwable!.rotationQuaternion!.asArray());
    objects.render(stopped, 0);
    nodes.forEach((node, i) =>
      assert.ok(
        node
          .throwable!.rotationQuaternion!.asArray()
          .every((value, axis) => Math.abs(value - landing[i]![axis]!) < 1e-12),
        'pausing at contact must not snap to the resting pose',
      ),
    );
    objects.render(stopped, 1);
    for (const node of nodes) {
      assert.equal(node.rotation.y, Math.PI / 2 - 0.4, 'zero velocity does not reset heading');
      const rotation = node.throwable!.rotationQuaternion!;
      assert.ok(Math.hypot(rotation.x, rotation.y, rotation.z) < 1e-5, 'stopped grenade settles');
    }
    objects.render(
      views.map(({ id, kind, x, y, z, angle }) => ({ id, kind, x, y, z, angle })),
      1,
    );
    for (const node of nodes)
      assert.deepEqual(node.throwable!.rotationQuaternion!.asArray(), [0, 0, 0, 1]);
    assert.deepEqual(views, before);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

void test('molotov fire reuses its material and animation observer across spawns', async () => {
  const { engine, scene, objects } = await fixture();
  try {
    const flame = { id: 1, kind: 'flame', x: 4, y: 5, z: 0 };
    objects.render([flame], 0);
    const first = scene.getTransformNodeByName('object-flame')!.getChildMeshes();
    const material = first[0]!.material;
    assert.equal(first.length, 1, 'wisps render in one mesh');
    assert.equal(new Set(first[0]!.getVerticesData('uv2')!.filter((_, i) => i % 2 === 0)).size, 18);
    assert.ok(
      first[0]!.getBoundingInfo().boundingBox.maximum.y >= 0.8,
      'bounds include GPU motion',
    );
    objects.render([], 0);
    const baseline = [
      scene.meshes.length,
      scene.materials.length,
      scene.onBeforeRenderObservable.observers.length,
    ];
    for (let i = 0; i < 8; i++) {
      objects.render([flame, { ...flame, id: 2, x: 6 }], 0.016);
      for (const node of scene.transformNodes.filter((node) => node.name === 'object-flame'))
        assert.equal(node.getChildMeshes()[0]!.material, material);
      objects.render([], 0.016);
      assert.deepEqual(
        [
          scene.meshes.length,
          scene.materials.length,
          scene.onBeforeRenderObservable.observers.length,
        ],
        baseline,
      );
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
