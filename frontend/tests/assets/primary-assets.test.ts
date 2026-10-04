import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { ModelAssets } from '../../src/presentation/assets/model-assets';
import { WeaponTextures } from '../../src/presentation/assets/weapon-textures';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { MODEL_NAMES, MODEL_DEFINITIONS } from '../../src/presentation/assets/model-catalog';
import { PRIMARY_MODELS } from '../../src/presentation/actors/arsenal';
import { createPrimary } from '../../../devtools/assets/primary-geometry';
import { primaryGLB } from '../../../devtools/assets/build-primaries';
import { WorldArt } from '../../src/presentation/environment/world-art';
import type { VisualKit } from '../../src/presentation/assets/visual-kit';

const load = async (kind: string, scene: Scene) =>
  LoadAssetContainerAsync(
    new Uint8Array(
      await readFile(new URL(`../../public/assets/kit/models/${kind}.glb`, import.meta.url)),
    ),
    scene,
    { pluginExtension: '.glb' },
  );
function points(mesh: AbstractMesh, attribute = 'position') {
  const values = mesh.getVerticesData(attribute)!;
  const world = mesh.computeWorldMatrix(true);
  const result: number[] = [];
  for (let i = 0; i < values.length; i += 3) {
    const v = Vector3.FromArray(values, i);
    result.push(
      ...(attribute === 'normal'
        ? Vector3.TransformNormal(v, world)
        : Vector3.TransformCoordinates(v, world)
      ).asArray(),
    );
  }
  return result;
}
function near(a: number[], b: number[]) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++)
    assert.ok(Math.abs(a[i]! - b[i]!) < 2e-6, `coordinate ${i}: ${a[i]} vs ${b[i]}`);
}
for (const kind of PRIMARY_MODELS) {
  void test(`${kind} GLB preserves authored geometry, materials and animated poses`, async () => {
    const engine = new NullEngine(),
      scene = new Scene(engine);
    try {
      const data = await readFile(
        new URL(`../../public/assets/kit/models/${kind}.glb`, import.meta.url),
      );
      assert.deepEqual(primaryGLB(kind), data, 'committed GLB must match its editable recipe');
      const parent = new TransformNode('actor', scene);
      const reference = createPrimary(scene, kind, parent, (name, hex, glow = 0) => {
        const m = new StandardMaterial(name, scene);
        m.diffuseColor = Color3.FromHexString(hex);
        m.emissiveColor = m.diffuseColor.scale(glow);
        m.specularColor = new Color3(0.07, 0.07, 0.06);
        return m;
      });
      const offset = MODEL_DEFINITIONS[kind]!.offset;
      if (offset) reference.position.copyFromFloats(...offset);
      const assets = new ModelAssets(scene, '', {}, (k) => load(k, scene));
      await assets.ready;
      assert.equal(assets.status[`${kind}.glb`], 'ready');
      const actual = assets.create(kind, parent);
      const expectedMeshes = reference.getChildMeshes(),
        actualMeshes = actual.getChildMeshes();
      assert.equal(actualMeshes.length, expectedMeshes.length);
      // Match by material and part; glTF groups moving nodes independently of recipe order.
      for (const pose of [0, 1]) {
        for (const model of [
          reference,
          {
            rotor: actual.parts.get('rotor'),
            charge: actual.parts.get('charge'),
          },
        ]) {
          if (model.rotor) model.rotor.rotation.z = pose * 1.2;
          if (model.charge) model.charge.scaling.setAll(1 + pose * 0.2);
        }
        for (const expected of expectedMeshes) {
          const part =
            ['rotor', 'charge'].find((p) => expected.parent?.name.endsWith(`-${p}`)) ?? 'static';
          const candidate = actualMeshes.find(
            (m) => m.material?.name === expected.material?.name && m.name.includes(`-${part}-`),
          )!;
          assert.ok(candidate);
          const source = candidate instanceof InstancedMesh ? candidate.sourceMesh : candidate;
          assert.ok(source instanceof Mesh);
          const pbr = expected.material instanceof PBRMaterial;
          assert.equal(source.sideOrientation, pbr ? 0 : 1);
          near(points(candidate), points(expected));
          near(points(candidate, 'normal'), points(expected, 'normal'));
          const a = candidate.material,
            b = expected.material;
          if (b instanceof PBRMaterial) {
            assert.ok(a instanceof PBRMaterial);
            near(a.albedoColor.asArray(), b.albedoColor.asArray());
            assert.equal(a.metallic, b.metallic);
          } else {
            assert.ok(a instanceof StandardMaterial && b instanceof StandardMaterial);
            near(a.diffuseColor.asArray(), b.diffuseColor.asArray());
          }
          assert.ok(a instanceof PBRMaterial || a instanceof StandardMaterial);
          assert.ok(b instanceof PBRMaterial || b instanceof StandardMaterial);
          near(a.emissiveColor.asArray(), b.emissiveColor.asArray());
          // Palette and emission come from the model; surface gloss is applied at load time.
          const indices = Array.from(expected.getIndices()!);
          // Native glTF PBR retains the opposite side orientation after handedness normalization.
          if (pbr)
            for (let i = 0; i < indices.length; i += 3)
              [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
          assert.deepEqual(Array.from(candidate.getIndices()!), indices);
        }
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
}
void test('late GLBs replace actor and pickup fallbacks, respect disposal, and share geometry', async () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const assets = new ModelAssets(scene, '', {}, async (kind) => {
      await gate;
      return load(kind, scene);
    });
    const parent = new TransformNode('actor', scene);
    const actor = assets.create('chain', parent);
    const deleted = assets.create('photon', parent);
    deleted.dispose();
    const world = new WorldArt(scene, (name) => new StandardMaterial(name, scene), {
      models: assets,
    } as VisualKit);
    const pickups = PRIMARY_MODELS.map((k) => world.create(k));
    const deletedPickup = world.create('shotgun');
    deletedPickup.dispose();
    actor.setEnabled(false);
    assert.ok(actor.getChildMeshes().some((m) => m.name.endsWith('-loading')));
    release();
    await assets.ready;
    // Model readiness does not wait for the separately loaded cosmetic textures.
    for (const kind of MODEL_NAMES) assert.equal(assets.status[`${kind}.glb`], 'ready', kind);
    assert.equal(actor.isEnabled(), false);
    assert.ok(actor.parts.get('rotor'));
    assert.equal(deleted.getChildMeshes().length, 0);
    for (const pickup of pickups)
      assert.ok(!pickup.getChildMeshes().some((m) => m.name.endsWith('-loading')));
    const count = scene.geometries.length;
    const other = assets.create('chain', parent);
    assert.equal(scene.geometries.length, count);
    actor.dispose();
    assert.ok(other.getChildMeshes().every((m) => !m.isDisposed()));
    const a = assets.create('photon', parent),
      b = assets.create('photon', parent);
    a.parts.get('charge')!.getChildMeshes()[0]!.visibility = 0.2;
    assert.equal(b.parts.get('charge')!.getChildMeshes()[0]!.visibility, 1);
    assert.equal(
      a.parts.get('charge')!.getChildMeshes()[0]!.getClassName(),
      'Mesh',
      'charge visibility needs cloned meshes, not GPU instances',
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
void test('failed GLBs retain a usable fallback and scene disposal handles in-flight loads', async () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const assets = new ModelAssets(scene, '', {}, async () => {
      await gate;
      throw new Error('test load failure');
    });
    const actor = assets.create('smg', new TransformNode('actor', scene));
    release();
    await assets.ready;
    assert.equal(assets.status['smg.glb'], 'failed');
    assert.ok(actor.getChildMeshes()[0]!.getTotalVertices() > 0);
    const later = assets.create('smg', new TransformNode('later', scene));
    assert.ok(later.getChildMeshes()[0]!.getTotalVertices() > 0);
  } finally {
    console.warn = warn;
    scene.dispose();
    engine.dispose();
  }
  const e = new NullEngine(),
    s = new Scene(e);
  const containers = await Promise.all(MODEL_NAMES.map((k) => load(k, s)));
  const assets = new ModelAssets(s, '', {}, (kind) =>
    Promise.resolve(containers[MODEL_NAMES.indexOf(kind)]!),
  );
  s.dispose();
  await assets.ready;
  assert.ok(containers.every((c) => c.meshes.every((m) => m.isDisposed())));
  e.dispose();
});

void test('equipment shares authored surfaces while preserving lights and distinct finishes', async () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const assets = new ModelAssets(scene, '', {}, (kind) => load(kind, scene));
    await assets.ready;
    const textures = new Set();
    for (const kind of [
      ...PRIMARY_MODELS,
      'knives',
      'grenade',
      'molotov',
      'rocket',
      'minibot',
      'weapon-mount',
      'health',
    ]) {
      const held = assets.create(kind, null),
        dropped = assets.create(kind, null);
      let textured = 0;
      for (let i = 0; i < held.meshes.length; i++) {
        const material = held.meshes[i]!.material!;
        assert.equal(material, dropped.meshes[i]!.material);
        const texture =
          material instanceof PBRMaterial
            ? material.albedoTexture
            : (material as StandardMaterial).diffuseTexture;
        if (texture) {
          textured++;
          textures.add(texture);
          assert.match(texture.name, /^equipment-(coating|steel|scorched|grip|cloth|paper)$/);
        }
        if (/recess|light/.test(material.name)) {
          assert.equal(texture, null, `${kind}: preserve luminous parts and dark bores`);
          if (material instanceof StandardMaterial) assert.equal(material.specularTexture, null);
        }
        if (material.name === 'bottle-green') {
          assert.equal(texture, null, 'glass scuffs affect gloss only');
          assert.equal((material as StandardMaterial).specularTexture?.name, 'equipment-steel');
        }
        if (material.name === 'bottle-wick') assert.equal(texture?.name, 'equipment-cloth');
        if (material.name === 'bottle-label') assert.equal(texture?.name, 'equipment-paper');
        if (kind === 'flamethrower' && material.name === 'equipment-steel')
          assert.equal(texture?.name, 'equipment-scorched');
        if (material.name === 'equipment-rubber') assert.equal(texture?.name, 'equipment-grip');
        if (material.name === 'equipment-dark-steel')
          assert.equal(
            texture?.name,
            ['flamethrower', 'chain'].includes(kind) ? 'equipment-scorched' : 'equipment-steel',
          );
        if (material.name === 'blade-steel') {
          assert.equal(texture?.name, 'equipment-steel');
          assert.ok((material as StandardMaterial).specularPower > 48);
        }
      }
      assert.ok(textured > 0, `${kind} must have surface textures`);
    }
    assert.equal(textures.size, 6, 'surface images are shared across all equipment');
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

void test('failed surface downloads detach from standard and container-owned PBR materials', (t) => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  const createTexture = engine.createTexture.bind(engine);
  let fail: NonNullable<Parameters<typeof createTexture>[6]> | undefined;
  t.mock.method(engine, 'createTexture', (...args: Parameters<typeof createTexture>) => {
    fail = args[6] ?? undefined;
    // This texture never finishes loading successfully.
    args[5] = null;
    return createTexture(...args);
  });
  t.mock.method(console, 'warn', () => {});
  try {
    const surfaces = new WeaponTextures(scene);
    const standard = new StandardMaterial('equipment-steel', scene);
    const imported = new PBRMaterial('steel', scene);
    scene.removeMaterial(imported);
    for (const material of [standard, imported]) {
      const mesh = MeshBuilder.CreateBox('equipment', {}, scene);
      mesh.material = material;
      surfaces.apply('smg', mesh);
    }
    assert.ok(standard.diffuseTexture);
    assert.equal(imported.albedoTexture, standard.diffuseTexture);
    assert.ok(fail);
    fail('offline', new Error('test download failure'));
    assert.equal(standard.diffuseTexture, null);
    assert.equal(standard.specularTexture, null);
    assert.equal(imported.albedoTexture, null);
    const late = MeshBuilder.CreateBox('late-equipment', {}, scene);
    late.material = imported;
    surfaces.apply('smg', late);
    assert.equal(
      imported.albedoTexture,
      null,
      'later consumers must not reattach the failed texture',
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
