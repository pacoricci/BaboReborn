import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneAudio } from '../../src/presentation/audio/scene-audio';
import type { AudioLoop } from '../../src/presentation/audio/combat-audio';
import type { ArenaView } from '../../src/presentation/view';

void test('movement and hazards follow visible poses, stop on reset and ignore respawn jumps', () => {
  const samples: string[] = [];
  let loops: readonly AudioLoop[] = [];
  const scene = new SceneAudio({
    sample(kind) {
      samples.push(kind);
    },
    syncLoops(value) {
      loops = value;
    },
    setListener() {},
  });
  const view: ArenaView = {
    player: { x: 4, y: 4, angle: 0, life: 1, primary: 'smg' },
    actors: [],
    objects: [{ id: 1, kind: 'flame', x: 5, y: 5, z: 0 }],
  };
  scene.update(view, 0.02);
  assert.equal(
    loops.some((l) => l.kind === 'fire-loop'),
    true,
  );
  assert.ok(!loops.some((l) => l.kind === 'roll-loop'));
  scene.update({ ...view, player: { ...view.player, x: 4.1 } }, 0.02);
  assert.equal(
    loops.some((l) => l.kind === 'roll-loop'),
    true,
  );
  scene.update({ ...view, player: { ...view.player, x: 4.1 } }, 0.02);
  assert.ok(samples.includes('roll-stop'));
  scene.update({ ...view, player: { ...view.player, life: 2, x: 40 } }, 0.02);
  assert.ok(!loops.some((l) => l.kind === 'roll-loop'));
  scene.update({ ...view, objects: [] }, 0.02);
  assert.ok(!loops.some((l) => l.kind === 'fire-loop'));
  scene.update(view, 0.02, false);
  assert.equal(loops.length, 0);
  scene.update(view, 0.02);
  assert.ok(!loops.some((l) => l.kind === 'roll-loop'));
});

void test('scope transitions sound once and persistent scene loops stay bounded', () => {
  const samples: string[] = [];
  let count = 0;
  const scene = new SceneAudio({
    sample(kind) {
      samples.push(kind);
    },
    syncLoops(v) {
      count = v.length;
    },
    setListener() {},
  });
  const view: ArenaView = {
    player: { x: 4, y: 4, angle: 0, primary: 'sniper' },
    actors: [],
    camera: { target: { x: 4, y: 4 }, height: 12 },
    objects: Array.from({ length: 100 }, (_, id) => ({ id, kind: 'rocket', x: id, y: 4, z: 0 })),
  };
  scene.update(view, 0.02);
  scene.update(view, 0.02);
  assert.deepEqual(samples, ['scope-in']);
  assert.ok(count <= 6);
  scene.update({ ...view, camera: { target: { x: 4, y: 4 }, height: 7 } }, 0.02);
  assert.deepEqual(samples, ['scope-in', 'scope-out']);
});
