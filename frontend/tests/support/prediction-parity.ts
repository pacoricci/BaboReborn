import assert from 'node:assert/strict';
import { createCollisionGrid } from '../../src/core/grid';
import { stepPlayer } from '../../src/core/simulation';
import type { Player, Shot } from '../../src/core/simulation';
import { predictionSuite } from './prediction-scenarios';

export const PARITY_TOLERANCE = 1e-10;
export interface PredictionCheckpoint {
  tick: number;
  state: Player;
  seed: number;
  shots: number;
  shot: Shot | null;
}
export interface PredictionReplay {
  id: string;
  checkpoints: PredictionCheckpoint[];
}

export function replayPrediction(): PredictionReplay[] {
  return predictionSuite.cases.map((scenario) => {
    const state = structuredClone(scenario.initial);
    const random = { seed: predictionSuite.randomSeed };
    const world = {
      walls: scenario.walls,
      grid: createCollisionGrid(predictionSuite.gridBounds, scenario.walls),
    };
    const checkpoints: PredictionCheckpoint[] = [];
    let tick = 0;
    let shots = 0;
    for (const segment of scenario.segments) {
      for (let i = 0; i < segment.ticks; i++) {
        const shot = stepPlayer(
          state,
          segment.input,
          scenario.dt,
          world,
          [],
          random,
          predictionSuite.shotGeometry,
        );
        if (shot) shots++;
        checkpoints.push({
          tick: ++tick,
          state: structuredClone(state),
          seed: random.seed,
          shots,
          shot,
        });
      }
    }
    return { id: scenario.id, checkpoints };
  });
}

// Compare the entire JSON tree: shape, ordering, strings, booleans and nulls are
// exact. Only finite floating-point values receive a tolerance. No field whitelist
// can silently omit equipment or shot properties added by either implementation.
export function compareParityValue(actual: unknown, expected: unknown, path = 'replay'): number {
  if (typeof expected === 'number') {
    assert.ok(
      typeof actual === 'number' && Number.isFinite(actual) && Number.isFinite(expected),
      `${path}: finite number`,
    );
    const difference = Math.abs(actual - expected);
    const exact = /\.(?:tick|seed|shots|targetId)$/.test(path);
    assert.ok(
      difference <= (exact ? 0 : PARITY_TOLERANCE),
      `${path}: Go ${actual}, TS ${expected}`,
    );
    return difference;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: array`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    let max = 0;
    for (let i = 0; i < expected.length; i++) {
      max = Math.max(max, compareParityValue(actual[i], expected[i], `${path}[${i}]`));
    }
    return max;
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(
      actual !== null && typeof actual === 'object' && !Array.isArray(actual),
      `${path}: object`,
    );
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    assert.deepEqual(Object.keys(a).sort(), Object.keys(e).sort(), `${path}: keys`);
    let max = 0;
    for (const key of Object.keys(e)) {
      max = Math.max(max, compareParityValue(a[key], e[key], `${path}.${key}`));
    }
    return max;
  }
  assert.equal(actual, expected, `${path}: value`);
  return 0;
}

export function predictionReport(results: PredictionReplay[]) {
  return {
    cases: results.length,
    checkpoints: results.reduce((n, result) => n + result.checkpoints.length, 0),
    shots: results.reduce((n, result) => n + result.checkpoints.filter((c) => c.shot).length, 0),
    rays: results.reduce(
      (n, result) =>
        n +
        result.checkpoints.reduce(
          (sum, c) => sum + (c.shot ? (c.shot.pellets?.length ?? 1) : 0),
          0,
        ),
      0,
    ),
    goTsTolerance: PARITY_TOLERANCE,
  };
}
