import { skins as SKIN_TEMPLATES } from '../support/content';
import test from 'node:test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MODEL_NAMES } from '../../src/presentation/assets/model-catalog';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';

for (const name of ['smg', 'wall']) {
  void test(`visual kit ${name} loads through glTF without a browser and preserves its anchor`, async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const data = new Uint8Array(
        await readFile(new URL(`../../public/assets/kit/models/${name}.glb`, import.meta.url)),
      );
      const container = await LoadAssetContainerAsync(data, scene, { pluginExtension: '.glb' });
      container.addAllToScene();
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      let triangles = 0;
      for (const mesh of container.meshes) {
        if (!mesh.getTotalVertices()) continue;
        mesh.computeWorldMatrix(true);
        const bounds = mesh.getBoundingInfo().boundingBox;
        min.minimizeInPlace(bounds.minimumWorld);
        max.maximizeInPlace(bounds.maximumWorld);
        triangles += mesh.getTotalIndices() / 3;
      }
      assert.ok(triangles > 0);
      if (name === 'smg') {
        // The imported model ends at the simulation's muzzle anchor and extends backwards.
        assert.ok(Math.abs(max.z) < 1e-6, `muzzle end drifted: ${max.z}`);
        assert.ok(Math.abs(min.z + 0.4) < 1e-6, `body length drifted: ${min.z}`);
        assert.ok(min.x < 0 && max.x > 0);
        assert.ok(max.x - min.x < 0.12);
      } else {
        for (const axis of ['x', 'y', 'z'] as const) {
          assert.ok(Math.abs(min[axis] + 0.5) < 1e-6);
          assert.ok(Math.abs(max[axis] - 0.5) < 1e-6);
        }
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
}

// The deterministic writer emits unfiltered RGB rows: verify actual exported masks,
// including all three independently colorable regions and normalized coverage.
for (const { id: name } of SKIN_TEMPLATES) {
  void test(`skin ${name} exports complete three-channel weights at the runtime dimensions`, async () => {
    const { inflateSync } = await import('node:zlib');
    const png = await readFile(new URL(`../../../content/skins/${name}/mask.png`, import.meta.url));
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 256);
    assert.equal(png[24], 8);
    assert.equal(png[25], 2);
    const chunks: Buffer[] = [];
    for (let i = 8; i < png.length;) {
      const length = png.readUInt32BE(i);
      if (png.toString('ascii', i + 4, i + 8) === 'IDAT')
        chunks.push(png.subarray(i + 8, i + 8 + length));
      i += length + 12;
    }
    const raw = inflateSync(Buffer.concat(chunks)),
      coverage = [0, 0, 0];
    assert.equal(raw.length, (512 * 3 + 1) * 256);
    for (let y = 0; y < 256; y++) {
      const row = y * (512 * 3 + 1);
      assert.equal(raw[row], 0);
      for (let x = 0; x < 512; x++) {
        const i = row + 1 + x * 3;
        assert.ok(Math.abs(raw[i]! + raw[i + 1]! + raw[i + 2]! - 255) <= 1);
        for (let c = 0; c < 3; c++) if (raw[i + c]! > 0) coverage[c] = coverage[c]! + 1;
      }
    }
    assert.ok(
      coverage.every((count) => count > 512 * 256 * 0.01),
      `missing color region: ${coverage.join(', ')}`,
    );
  });
}

void test('equipment instances survive actor disposal without duplicating template geometry', async () => {
  const { createArsenal } = await import('../../src/presentation/actors/arsenal');
  const { TransformNode } = await import('@babylonjs/core/Meshes/transformNode');
  const { ModelAssets } = await import('../../src/presentation/assets/model-assets');
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const assets = new ModelAssets(scene, '', {}, async (kind) =>
      LoadAssetContainerAsync(
        new Uint8Array(
          await readFile(new URL(`../../public/assets/kit/models/${kind}.glb`, import.meta.url)),
        ),
        scene,
        { pluginExtension: '.glb' },
      ),
    );
    await assets.ready;
    // Model readiness does not wait for the separately loaded cosmetic textures.
    for (const kind of MODEL_NAMES) assert.equal(assets.status[`${kind}.glb`], 'ready', kind);
    const first = new TransformNode('first', scene),
      second = new TransformNode('second', scene);
    const a = createArsenal(assets, first);
    const templates = scene.geometries.length;
    const b = createArsenal(assets, second);
    assert.equal(scene.geometries.length, templates);
    assert.equal(a.size, 8);
    assert.equal(b.size, 8);
    const rotor = a.get('chain')!.parts.get('rotor')!;
    const otherRotor = b.get('chain')!.parts.get('rotor')!;
    rotor.rotation.z = 1.2;
    a.get('photon')!.parts.get('charge')!.getChildMeshes()[0]!.visibility = 0.2;
    assert.equal(otherRotor.rotation.z, 0);
    assert.equal(b.get('photon')!.parts.get('charge')!.getChildMeshes()[0]!.visibility, 1);
    first.dispose();
    for (const node of b.values()) {
      node.setEnabled(true);
      assert.ok(node.getChildMeshes().length > 0);
      for (const mesh of node.getChildMeshes()) {
        assert.equal(mesh.isDisposed(), false);
        assert.ok(mesh.getTotalVertices() > 0);
        assert.ok(mesh.getVerticesData('position')!.every(Number.isFinite));
      }
    }
    assert.equal(scene.geometries.length, templates);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
