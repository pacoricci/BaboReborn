import test from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { BloodEffects } from '../../src/presentation/effects/blood';

void test('blood remains bounded under sustained fire, lands, expires and resets without leaking meshes', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const blood = new BloodEffects(scene);
  try {
    for (let i = 0; i < 200; i++) blood.hit({ x: 4, y: 4 }, 100);
    assert.ok(scene.meshes.length <= 264);
    blood.render(1);
    assert.equal(scene.meshes.length, 24, 'only floor stains survive landing');
    blood.render(9);
    assert.equal(scene.meshes.length, 0);
    blood.hit({ x: 4, y: 4 }, 30);
    blood.reset();
    assert.equal(scene.meshes.length, 0);
    blood.hit({ x: 4, y: 4 }, 0);
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
