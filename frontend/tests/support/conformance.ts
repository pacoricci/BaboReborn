// Test-side adapter. Fixtures contain reference expectations; this module only
// executes the implementation and compares results, never generates expectations.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createCollisionGrid } from '../../src/core/grid';
import { stepPlayer } from '../../src/core/simulation';
import type { Input, Player, ShotGeometry } from '../../src/core/simulation';
import type { MovingBody, Wall } from '../../src/core/geometry';
import { createEquipment } from '../../src/core/equipment';
import { MOVEMENT, SMG } from '../../src/gameconfig/tuning';

export interface ReferenceCase {
  id: string;
  derivation: string;
  sources: string[];
  dt: number;
  initial: Omit<Player, 'equipment'>;
  walls: Wall[];
  segments: { ticks: number; input: Input }[];
  checkpoints: { tick: number; state: MovingBody; shots: number }[];
}
interface ReferenceSuite {
  schemaVersion: number;
  reference: { repository: string; revision: string; profile: string; evidence: string };
  units: Record<string, string>;
  tolerances: { positionAbsolute: number; velocityAbsolute: number };
  parameters: { movement: typeof MOVEMENT; smgRecoil: number };
  gridBounds: Wall;
  randomSeed: number;
  shotGeometry: ShotGeometry;
  sources: Record<string, string>;
  cases: ReferenceCase[];
}
export const suite: ReferenceSuite = JSON.parse(
  readFileSync(new URL('../fixtures/movement-reference.json', import.meta.url), 'utf8'),
) as ReferenceSuite;
const fields = ['x', 'y', 'vx', 'vy'] as const;

export function validateSuite(): void {
  assert.equal(suite.schemaVersion, 1);
  assert.match(suite.reference.revision, /^[a-f0-9]{40}$/);
  // Check the movement parameters exercised by these analytic cases.
  for (const [key, expected] of Object.entries(suite.parameters.movement))
    assert.equal(
      MOVEMENT[key as keyof typeof MOVEMENT],
      expected,
      `Movement parameter drift: ${key}`,
    );
  assert.equal(SMG.recoil, suite.parameters.smgRecoil, 'SMG recoil parameter drift');
  for (const tolerance of Object.values(suite.tolerances)) {
    assert.ok(Number.isFinite(tolerance) && tolerance > 0 && tolerance <= 1e-5);
  }
  const ids = new Set<string>();
  assert.ok(suite.cases.length > 0);
  for (const scenario of suite.cases) {
    assert.ok(!ids.has(scenario.id), `Duplicate case ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(scenario.derivation.trim());
    assert.ok(scenario.sources.length && scenario.sources.every((id) => suite.sources[id]));
    assert.ok(Number.isFinite(scenario.dt) && scenario.dt > 0);
    for (const value of Object.values(scenario.initial)) assert.ok(Number.isFinite(value));
    let ticks = 0;
    for (const segment of scenario.segments) {
      assert.ok(Number.isSafeInteger(segment.ticks) && segment.ticks > 0);
      assert.ok([-1, 0, 1].includes(segment.input.x) && [-1, 0, 1].includes(segment.input.y));
      assert.equal(typeof segment.input.fire, 'boolean');
      assert.ok(Number.isFinite(segment.input.aim.x) && Number.isFinite(segment.input.aim.y));
      ticks += segment.ticks;
    }
    let previousTick = 0;
    for (const checkpoint of scenario.checkpoints) {
      assert.ok(
        Number.isSafeInteger(checkpoint.tick) &&
          checkpoint.tick > previousTick &&
          checkpoint.tick <= ticks,
      );
      assert.deepEqual(Object.keys(checkpoint.state).sort(), [...fields].sort());
      for (const field of fields) {
        assert.ok(Number.isFinite(checkpoint.state[field]));
      }
      assert.ok(Number.isSafeInteger(checkpoint.shots) && checkpoint.shots >= 0);
      previousTick = checkpoint.tick;
    }
    assert.equal(previousTick, ticks, `${scenario.id}: final state must be checked`);
  }
}

interface Difference {
  tick: number;
  field: string;
  expected: number;
  actual: number;
  tolerance: number;
}

export function compareCase(scenario: ReferenceCase) {
  const player = referencePlayer(scenario);
  const random = { seed: suite.randomSeed };
  const geometry = {
    walls: scenario.walls,
    grid: createCollisionGrid(suite.gridBounds, scenario.walls),
  };
  const differences: Difference[] = [];
  const checkpoints = [];
  let tick = 0,
    shots = 0,
    checkpointIndex = 0;
  for (const segment of scenario.segments) {
    for (let i = 0; i < segment.ticks; i++) {
      if (stepPlayer(player, segment.input, scenario.dt, geometry, [], random, suite.shotGeometry))
        shots++;
      tick++;
      const expected = scenario.checkpoints[checkpointIndex];
      if (tick !== expected?.tick) continue;
      const state = { x: player.x, y: player.y, vx: player.vx, vy: player.vy };
      checkpoints.push({ tick, state, shots });
      for (const field of [...fields, 'shots'] as const) {
        const actualValue = field === 'shots' ? shots : state[field];
        const expectedValue = field === 'shots' ? expected.shots : expected.state[field];
        const tolerance =
          field === 'shots'
            ? 0
            : field === 'x' || field === 'y'
              ? suite.tolerances.positionAbsolute
              : suite.tolerances.velocityAbsolute;
        if (!Number.isFinite(actualValue) || Math.abs(actualValue - expectedValue) > tolerance) {
          differences.push({
            tick,
            field,
            expected: expectedValue,
            actual: actualValue,
            tolerance,
          });
        }
      }
      checkpointIndex++;
    }
  }
  return {
    id: scenario.id,
    status: differences.length ? 'different' : 'conformant',
    differences,
    checkpoints,
  };
}

export function referencePlayer(scenario: ReferenceCase): Player {
  return { ...scenario.initial, equipment: createEquipment() };
}
