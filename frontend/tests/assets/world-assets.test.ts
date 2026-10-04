import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { ModelAssets } from '../../src/presentation/assets/model-assets';
import { WORLD_MODELS } from '../../src/presentation/assets/model-catalog';
import { createWorldGeometry } from '../../../devtools/assets/world-geometry';
import { worldGLB } from '../../../devtools/assets/build-world';
import { WorldArt } from '../../src/presentation/environment/world-art';
const load = async (kind: string, scene: Scene) =>
  LoadAssetContainerAsync(
    new Uint8Array(
      await readFile(new URL(`../../public/assets/kit/models/${kind}.glb`, import.meta.url)),
    ),
    scene,
    { pluginExtension: '.glb' },
  );
function factory(scene: Scene) {
  return (name: string, hex: string, glow = 0) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = Color3.FromHexString(hex);
    m.emissiveColor = m.diffuseColor.scale(glow);
    m.specularColor = new Color3(0.07, 0.07, 0.06);
    return m;
  };
}
function coordinates(mesh: AbstractMesh, normal = false): number[] {
  const v = mesh.getVerticesData(normal ? 'normal' : 'position')!,
    matrix = mesh.computeWorldMatrix(true),
    out: number[] = [];
  for (let i = 0; i < v.length; i += 3) {
    const value = Vector3.FromArray(v, i);
    out.push(
      ...(normal
        ? Vector3.TransformNormal(value, matrix)
        : Vector3.TransformCoordinates(value, matrix)
      ).asArray(),
    );
  }
  return out;
}
function near(a: ArrayLike<number>, b: ArrayLike<number>) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++)
    assert.ok(Math.abs(a[i]! - b[i]!) < 2e-6, `coordinate ${i}: ${a[i]} vs ${b[i]}`);
}
for (const kind of WORLD_MODELS) {
  void test(`${kind} GLB preserves source geometry, materials and device motion`, async () => {
    const engine = new NullEngine(),
      scene = new Scene(engine);
    try {
      assert.deepEqual(
        worldGLB(kind),
        await readFile(new URL(`../../public/assets/kit/models/${kind}.glb`, import.meta.url)),
      );
      const source = createWorldGeometry(scene, kind, factory(scene));
      const groups = source.getChildTransformNodes(true);
      const reference = [
        ...source.getChildMeshes(true),
        ...groups.flatMap((g) => g.getChildMeshes(true)),
      ];
      const assets = new ModelAssets(scene, '', {}, (k) => load(k, scene));
      await assets.ready;
      assert.ok(
        Object.entries(assets.status)
          .filter(([name]) => name.endsWith('.glb'))
          .every(([, state]) => state === 'ready'),
      );
      const actual = assets.create(kind, null);
      assert.equal(actual.meshes.length, reference.length);
      for (const pose of [0, 1]) {
        const head = groups.find((g) => g.name === 'turret-head');
        if (head) {
          head.rotation.y = pose * 1.1;
          actual.parts.get('turret-head')!.rotation.y = head.rotation.y;
        }
        for (let i = 0; i < reference.length; i++) {
          const a = actual.meshes[i]!,
            b = reference[i]!;
          near(coordinates(a), coordinates(b));
          near(coordinates(a, true), coordinates(b, true));
          // Equipment now has presentation-projected UVs; other world assets retain recipe UVs.
          if (!(a.material as StandardMaterial).diffuseTexture)
            near(a.getVerticesData('uv')!, b.getVerticesData('uv')!);
          else {
            const uv = Array.from(a.getVerticesData('uv')!);
            assert.ok(uv.every(Number.isFinite));
            assert.equal(uv.length, a.getTotalVertices() * 2);
            assert.ok(new Set(uv).size > 1);
          }
          const indices = Array.from(b.getIndices()!);
          const am = a.material,
            bm = b.material;
          if (bm instanceof PBRMaterial) {
            assert.ok(am instanceof PBRMaterial);
            near(am.albedoColor.asArray(), bm.albedoColor.asArray());
            assert.equal(am.metallic, bm.metallic);
            assert.equal(am.roughness, bm.roughness);
            for (let i = 0; i < indices.length; i += 3)
              [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
          } else {
            assert.ok(am instanceof StandardMaterial && bm instanceof StandardMaterial);
            near(am.diffuseColor.asArray(), bm.diffuseColor.asArray());
          }
          assert.ok(am instanceof PBRMaterial || am instanceof StandardMaterial);
          assert.ok(bm instanceof PBRMaterial || bm instanceof StandardMaterial);
          assert.deepEqual(Array.from(a.getIndices()!), indices);
          near(am.emissiveColor.asArray(), bm.emissiveColor.asArray());
        }
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
}
void test('late world assets preserve owner poses, effects and per-actor materials', async () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const assets = new ModelAssets(scene, '', {}, async (k) => {
      await gate;
      return load(k, scene);
    });
    const skinA = new StandardMaterial('skin-a', scene),
      skinB = new StandardMaterial('skin-b', scene),
      hit = new StandardMaterial('hit', scene);
    const a = assets.create('babo', null, { material: skinA }),
      b = assets.create('babo', null, { material: skinB });
    a.material = hit;
    const art = new WorldArt(scene, factory(scene), {
      models: assets,
      flash: new StandardMaterial('flash', scene),
    });
    const turretA = art.create('minibot'),
      turretB = art.create('minibot');
    turretA.turretHead!.rotation.y = 1.5;
    turretA.muzzle!.setEnabled(true);
    const deleted = art.create('grenade');
    deleted.dispose();
    const knives = assets.create('knives', null);
    knives.setEnabled(false);
    knives.rotation.y = 0.7;
    release();
    await assets.ready;
    assert.ok(a.meshes.every((m) => m.material === hit));
    assert.ok(b.meshes.every((m) => m.material === skinB));
    a.material = skinA;
    assert.ok(a.meshes.every((m) => m.material === skinA));
    assert.ok(b.meshes.every((m) => m.material === skinB));
    assert.equal(turretA.turretHead!.rotation.y, 1.5);
    assert.equal(turretB.turretHead!.rotation.y, 0);
    assert.equal(turretA.muzzle!.parent, turretA.turretHead);
    assert.equal(turretA.muzzle!.isEnabled(), true);
    assert.equal(turretB.muzzle!.isEnabled(), false);
    assert.equal(deleted.getChildMeshes().length, 0);
    assert.equal(knives.isEnabled(), false);
    assert.equal(knives.rotation.y, 0.7);
    const geometry = scene.geometries.length;
    const c = assets.create('babo', null, { material: skinB });
    assert.equal(scene.geometries.length, geometry);
    a.dispose();
    assert.ok(c.meshes.every((m) => !m.isDisposed()));
    // Wall consumers can remap clone UVs without corrupting the shared source or another wall.
    const wallA = assets.create('wall', null),
      wallB = assets.create('wall', null);
    const meshA = wallA.meshes[0] as Mesh,
      meshB = wallB.meshes[0] as Mesh;
    const previous = Array.from(meshB.getVerticesData('uv')!);
    meshA.makeGeometryUnique();
    meshA.setVerticesData(
      'uv',
      previous.map((v) => v * 3),
    );
    assert.deepEqual(Array.from(meshB.getVerticesData('uv')!), previous);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

void test('fitted weapon shell exposes its outer faces above the Babo surface', () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const root = createWorldGeometry(scene, 'weapon-mount', factory(scene));
    for (const mesh of root.getChildMeshes().filter((mesh) => mesh.name === 'fitted-shell')) {
      const positions = mesh.getVerticesData('position')!;
      const normals = mesh.getVerticesData('normal')!;
      // Each closed patch exports its outer skin before the inner lining.
      for (let i = 0; i < positions.length / 2; i += 3) {
        const x = positions[i]!,
          y = positions[i + 1]! - 0.25,
          z = positions[i + 2]!;
        assert.ok(Math.hypot(x, y, z) > 0.25, 'outer surface must clear the body');
        assert.ok(
          x * normals[i]! + y * normals[i + 1]! + z * normals[i + 2]! > 0,
          'outer faces must point away from the body for back-face culling',
        );
      }
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

void test('objective deck insignia and team markers face the overhead camera', async () => {
  const { VertexData } = await import('@babylonjs/core/Meshes/mesh.vertexData');
  const { createTeamMarker } = await import('../../src/presentation/actors/team-marker');
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    for (const team of ['blue', 'red']) {
      const base = createWorldGeometry(scene, `base-${team}`, factory(scene));
      const emblem = base.getChildMeshes().find((m) => m.material?.name === 'objective-ivory')!;
      const marker = createTeamMarker(scene, factory(scene));
      for (const mesh of [emblem, marker.ring, ...marker.ring.getChildMeshes()]) {
        const normals: number[] = [];
        VertexData.ComputeNormals(mesh.getVerticesData('position')!, mesh.getIndices()!, normals);
        for (let i = 1; i < normals.length; i += 3)
          assert.ok(normals[i]! > 0.99, `${mesh.name} must survive overhead back-face culling`);
      }
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
