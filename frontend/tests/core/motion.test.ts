import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { MotionSampler, stepFlight, stepRocket } from '../../src/core/motion';
import type { Flight, Motion } from '../../src/core/motion';
import type { Vec3, Wall } from '../../src/core/geometry';

void test('Go and browser motion agree each tick across gravity, all wall faces, cover, corners, rest and rocket cap', () => {
  const scenarios: {
    flight: Flight;
    mode: string;
    walls: Wall[];
    height: number;
    steps: number;
  }[] = [];
  for (const [position, velocity] of [
    [
      { x: 4.99, y: 5.5, z: 1.2 },
      { x: 5, y: 1, z: 2 },
    ],
    [
      { x: 6.01, y: 5.5, z: 1.2 },
      { x: -5, y: 1, z: 2 },
    ],
    [
      { x: 5.5, y: 4.99, z: 1.2 },
      { x: 1, y: 5, z: 2 },
    ],
    [
      { x: 5.5, y: 6.01, z: 1.2 },
      { x: 1, y: -5, z: 2 },
    ],
    [
      { x: 4.99, y: 4.99, z: 1.2 },
      { x: 5, y: 5, z: 2 },
    ],
    [
      { x: 4, y: 4, z: 0.21839080810546876 },
      { x: 5, y: 0, z: 5 },
    ],
    [
      { x: 4, y: 4, z: 0.1 },
      { x: 0.01, y: 0, z: 0.01 },
    ],
  ] as [Vec3, Vec3][])
    for (const height of [1, 3])
      for (const mode of ['bounce', 'fall']) {
        scenarios.push({
          flight: { position, velocity },
          mode,
          walls: [{ x: 5, y: 5, w: 1, h: 1, height }],
          height: 0.7,
          steps: 1200,
        });
      }
  scenarios.push({
    flight: { position: { x: 0, y: 0, z: 0.3 }, velocity: { x: 1.5, y: 2, z: 0 } },
    mode: 'rocket',
    walls: [],
    height: 0.7,
    steps: 2400,
  });
  const actual = JSON.parse(
    execFileSync('go', ['run', './backend/cmd/motion-conformance'], {
      input: JSON.stringify(scenarios),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  ) as { flight: Flight; normal: Vec3 | null }[][];
  let maximum = 0;
  scenarios.forEach((s, index) => {
    const f = structuredClone(s.flight);
    for (let tick = 0; tick < actual[index]!.length; tick++) {
      const normal =
        s.mode === 'rocket'
          ? (stepRocket(f), null)
          : stepFlight(f, s.walls, s.height, s.mode === 'bounce');
      const expected = actual[index]![tick]!;
      assert.deepEqual(normal, expected.normal, `contact ${index}/${tick}`);
      for (const group of ['position', 'velocity'] as const)
        for (const key of ['x', 'y', 'z'] as const) {
          const error = Math.abs(f[group][key] - expected.flight[group][key]);
          maximum = Math.max(maximum, error);
          assert.ok(error <= 1e-9, `${index}/${tick} ${group}.${key}: ${error}`);
        }
    }
  });
  assert.ok(maximum <= 1e-9);
});

void test('motion sampler is immutable, bounded and independent of render sampling order', () => {
  const motion: Motion = {
    motion: 'bounce',
    motionTick: 50,
    position: { x: 1, y: 1, z: 2 },
    velocity: { x: 3, y: 1, z: 2 },
  };
  const before = structuredClone(motion),
    sampler = new MotionSampler([], 0.7);
  const late = sampler.at(motion, 169.5),
    early = sampler.at(motion, 60.5);
  assert.deepEqual(early, new MotionSampler([], 0.7).at(motion, 60.5));
  assert.deepEqual(late, new MotionSampler([], 0.7).at(motion, 169.5));
  assert.deepEqual(sampler.at(motion, 100000), sampler.at(motion, 170));
  assert.deepEqual(motion, before);
});

void test('bounded trajectory wall selection preserves the unfiltered collision path', () => {
  const walls: Wall[] = Array.from({ length: 64 }, (_, i) => ({
    x: (i % 8) * 2,
    y: Math.floor(i / 8) * 2,
    w: 0.8,
    h: 0.8,
    height: i % 2 ? 1 : 3,
  }));
  for (const direction of [-1, 1])
    for (const speed of [0.01, 2, 12]) {
      const motion: Motion = {
        motion: 'bounce',
        motionTick: 0,
        position: { x: 5.99, y: 5.99, z: 2 },
        velocity: { x: direction * speed, y: speed, z: 3 },
      };
      const f = structuredClone(motion),
        sampler = new MotionSampler(walls, 0.7);
      for (let tick = 0; tick <= 120; tick++) {
        assert.deepEqual(sampler.at(motion, tick).position, f.position, `tick ${tick}`);
        assert.deepEqual(sampler.at(motion, tick).velocity, f.velocity, `tick ${tick}`);
        stepFlight(f, walls, 0.7, true);
      }
    }
});
