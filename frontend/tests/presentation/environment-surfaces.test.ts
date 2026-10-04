import { themes } from '../support/content';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Scene } from '@babylonjs/core/scene';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { ModelAssets } from '../../src/presentation/assets/model-assets';
import { wallSurface } from '../../src/presentation/environment/wall-surface';
import { terrain } from '../../src/presentation/environment/terrain';

void test('wall surface groups preserve imported triangles and keep coping on upward faces', async () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const materials = new MultiMaterial('surfaces', scene);
    materials.subMaterials.push(
      new StandardMaterial('side', scene),
      new StandardMaterial('cap', scene),
    );
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
    const wall = { x: 3, y: 8, w: 7, h: 2, height: 1.5 };
    const node = models.create('wall', null, {
      material: materials,
      configureMesh: (mesh) => {
        const positions = Array.from(mesh.getVerticesData('position')!);
        const indices = Array.from(mesh.getIndices()!);
        // Includes both the loading primitive and the actual imported wall.
        assert.ok(mesh instanceof Mesh);
        wallSurface(mesh, wall, materials);
        assert.deepEqual(Array.from(mesh.getVerticesData('position')!), positions);
        const triangles = (values: number[]) =>
          Array.from({ length: values.length / 3 }, (_, i) =>
            values.slice(i * 3, i * 3 + 3).join(','),
          ).sort();
        assert.deepEqual(triangles(Array.from(mesh.getIndices()!)), triangles(indices));
        const normals = mesh.getVerticesData('normal')!;
        for (const group of mesh.subMeshes) {
          for (const index of Array.from(mesh.getIndices()!).slice(
            group.indexStart,
            group.indexStart + group.indexCount,
          ))
            assert.equal(normals[index * 3 + 1]! > 0.5, group.materialIndex === 1);
        }
        assert.equal(mesh.subMeshes.length, 2);
      },
    });
    assert.equal(node.meshes.length, 1);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

void test('rectangular terrain without route metadata has static wear and keeps materials reusable', () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const materials = {
      theme: themes.find((t) => t.id === 'classic')!,
      terrain: new StandardMaterial('grass', scene),
      earth: new StandardMaterial('earth', scene),
    };
    const walls = [{ x: 2, y: 2, w: 4, h: 1 }];
    terrain(scene, 12, materials, undefined, 8, walls);
    const floor = scene.getMeshByName('floor')!,
      wear = scene.getMeshByName('terrain-wear')!;
    const colors = Array.from(wear.getVerticesData('color')!);
    assert.ok(colors.every(Number.isFinite));
    const alpha = colors.filter((_, i) => i % 4 === 3);
    assert.ok(Math.max(...alpha) > 0.5);
    assert.equal(Math.min(...alpha), 0);
    assert.ok(alpha.every((a) => a >= 0 && a <= 1));
    const positions = Array.from(floor.getVerticesData('position')!);
    assert.equal(Math.max(...positions.filter((_, i) => i % 3 === 0)), 6);
    assert.equal(Math.max(...positions.filter((_, i) => i % 3 === 2)), 4);
    floor.dispose();
    wear.dispose();
    terrain(scene, 12, materials, undefined, 8, walls);
    assert.deepEqual(
      Array.from(scene.getMeshByName('terrain-wear')!.getVerticesData('color')!),
      colors,
    );
    assert.equal(scene.materials.length, 2);
    assert.equal(scene.meshes.length, 2);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
void test('constructed scenario floors keep geometry but omit outdoor tint and dirt', () => {
  const engine = new NullEngine();
  for (const theme of ['futuristic', 'cyberpunk', 'medieval'] as const) {
    const scene = new Scene(engine);
    try {
      terrain(
        scene,
        16,
        {
          terrain: new StandardMaterial('floor', scene),
          earth: new StandardMaterial('earth', scene),
          theme: themes.find((t) => t.id === theme)!,
        },
        undefined,
        24,
      );
      const floor = scene.getMeshByName('floor')!;
      assert.equal(scene.getMeshByName('terrain-wear'), null);
      assert.equal(floor.getVerticesData('color'), null);
      assert.equal(floor.position.x, 8);
      assert.equal(floor.position.z, 12);
      assert.equal(floor.isPickable, false);
    } finally {
      scene.dispose();
    }
  }
  engine.dispose();
});
