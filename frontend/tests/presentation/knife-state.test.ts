import assert from 'node:assert/strict';
import test from 'node:test';
import { knifeExtension } from '../../src/presentation/actors/knife-state';

void test('popup knives follow original deploy, hold and retract timing', () => {
  for (const [remaining, expected] of [
    [1, 0],
    [0.95, 0.5],
    [0.9, 1],
    [0.5, 1],
    [0.25, 1],
    [0.125, 0.5],
    [0, 0],
    [-1, 0],
  ]) {
    assert.ok(Math.abs(knifeExtension(remaining!, 1) - expected!) < 1e-9);
  }
});
