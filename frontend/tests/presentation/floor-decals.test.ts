import test from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { FloorDecals } from '../../src/presentation/environment/floor-decals';
import { FLOOR_LAYERS } from '../../src/presentation/environment/floor-layers';
import { bundledCatalog } from '../support/content';
import { newMap } from '../../src/apps/editor/model';

void test('floor art shares materials with independent opacity and releases its resources', () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const decal = { asset: 'oil', x: 8, y: 8, w: 2, h: 2, angle: 0, opacity: 0.6 };
    const art = new FloorDecals(
      scene,
      { ...newMap(), decals: [decal, { ...decal, x: 10, opacity: 0.3 }] },
      bundledCatalog,
      {},
    );
    const [a, b] = art.meshes;
    assert.ok(a && b);
    assert.equal(a.material, b.material);
    assert.equal(scene.textures.length, 1);
    assert.equal(a.visibility, 0.6);
    assert.equal(b.visibility, 0.3);
    assert.equal(a.isPickable, false);
    assert.ok(a.alphaIndex < b.alphaIndex && b.alphaIndex < 0);
    assert.ok(a.alphaIndex > FLOOR_LAYERS.wear);
    assert.equal(a.isWorldMatrixFrozen, true);
    const texture = scene.textures[0]!;
    art.dispose();
    assert.ok(a.isDisposed() && b.isDisposed());
    assert.equal(scene.textures.includes(texture), false);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
