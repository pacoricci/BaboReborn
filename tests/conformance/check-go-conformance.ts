import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { suite, validateSuite, referencePlayer } from '../../frontend/tests/support/conformance';
import type { Player } from '../../frontend/src/core/simulation';
import { stepPlayer } from '../../frontend/src/core/simulation';
import { createCollisionGrid } from '../../frontend/src/core/grid';
validateSuite();
const result = JSON.parse(
  execFileSync('go', ['run', './backend/cmd/conformance'], {
    input: JSON.stringify(suite),
    encoding: 'utf8',
  }),
) as { id: string; checkpoints: { tick: number; shots: number; seed: number; state: Player }[] }[];
assert.equal(result.length, suite.cases.length);
let checkpoints = 0;
for (const [index, scenario] of suite.cases.entries()) {
  const go = result[index];
  assert.ok(go);
  assert.equal(go.id, scenario.id);
  const p = referencePlayer(scenario),
    random = { seed: suite.randomSeed };
  const geometry = {
    walls: scenario.walls,
    grid: createCollisionGrid(suite.gridBounds, scenario.walls),
  };
  let tick = 0,
    shots = 0,
    ci = 0;
  for (const segment of scenario.segments)
    for (let i = 0; i < segment.ticks; i++) {
      if (stepPlayer(p, segment.input, scenario.dt, geometry, [], random, suite.shotGeometry))
        shots++;
      tick++;
      const expected = scenario.checkpoints[ci];
      if (tick !== expected?.tick) continue;
      const actual: { tick: number; shots: number; seed: number; state: Player } | undefined =
        go.checkpoints[ci++];
      checkpoints++;
      assert.ok(actual);
      assert.equal(actual.tick, tick);
      assert.equal(actual.shots, expected.shots);
      assert.equal(actual.shots, shots);
      assert.equal(actual.seed, random.seed);
      for (const field of ['x', 'y', 'vx', 'vy'] as const) {
        const tolerance =
          field === 'x' || field === 'y'
            ? suite.tolerances.positionAbsolute
            : suite.tolerances.velocityAbsolute;
        assert.ok(
          Number.isFinite(actual.state[field]) &&
            Math.abs(actual.state[field] - expected.state[field]) <= tolerance,
          `${scenario.id}:${tick} reference ${field}`,
        );
      }
      for (const field of ['x', 'y', 'vx', 'vy', 'angle', 'cooldown', 'spread'] as const) {
        assert.ok(
          Math.abs(actual.state[field] - p[field]) <= 1e-10,
          `${scenario.id}:${tick} Go/TS ${field}`,
        );
      }
    }
  assert.equal(go.checkpoints.length, ci);
}
console.log(
  JSON.stringify(
    {
      cases: result.length,
      checkpoints,
      sourceTolerance: suite.tolerances,
      goTsTolerance: 1e-10,
      status: 'passed',
    },
    null,
    2,
  ),
);
