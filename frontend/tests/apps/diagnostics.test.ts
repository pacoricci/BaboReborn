import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchDiagnostics } from '../../src/apps/match/diagnostic-history';
import { Interpolation } from '../../src/prediction/model';
import { snap } from '../support/online';

void test('timeline keeps ordered bounded history and expires it even without new frames', () => {
  const diagnostics = new MatchDiagnostics();
  diagnostics.setEnabled(true, -1);
  for (let i = 0; i < 24005; i++) diagnostics.record('frame', i, { intervalMs: 1 });
  const full = diagnostics.snapshot(24005);
  assert.equal(full.samples.length, 24000);
  assert.equal(full.capacityEvictions, 6);
  assert.equal(full.samples[0]!.atMs, 5);
  assert.equal(full.samples.at(-1)!.atMs, 24004);
  assert.ok(full.samples.every((sample, i) => sample.atMs === i + 5));
  const expired = diagnostics.snapshot(144003);
  assert.deepEqual(
    expired.samples.map((sample) => sample.atMs),
    [24003, 24004],
  );
  assert.equal(diagnostics.snapshot(144005).samples.length, 0);
  assert.equal(full.samples.length, 24000, 'exported arrays are detached from the ring');
});

void test('starvation summary counts episodes only in retained active frames', () => {
  const diagnostics = new MatchDiagnostics();
  diagnostics.setEnabled(true, -1);
  for (const [i, active, starved] of [
    [0, true, true],
    [1, true, true],
    [2, false, true],
    [3, true, true],
    [4, true, false],
  ] as const)
    diagnostics.record('frame', i, { active, interpolationStarved: starved });
  assert.deepEqual(diagnostics.snapshot(5).activeInterpolation, {
    starvedFrames: 3,
    starvationEpisodes: 2,
  });
});

void test('interpolation telemetry detects exhausted history and recovers on a fresh sample', () => {
  const interpolation = new Interpolation();
  assert.equal(interpolation.diagnostics(0, 120).latestAgeMs, null);
  interpolation.push(snap(4), 100);
  interpolation.push(snap(8), 133);
  assert.equal(interpolation.diagnostics(233, 120).starved, false);
  assert.equal(interpolation.diagnostics(234, 120).starved, true);
  assert.equal(interpolation.diagnostics(234, 120).latestAgeMs, 101);
  interpolation.push(snap(20), 235);
  assert.equal(interpolation.diagnostics(235, 120).starved, false);
});

void test('collection defaults off, freezes on stop, and resumes with an explicit boundary', () => {
  const diagnostics = new MatchDiagnostics();
  diagnostics.record('frame', 10, { intervalMs: 10 });
  assert.equal(diagnostics.enabled, false);
  assert.deepEqual(diagnostics.snapshot(20).samples, []);
  diagnostics.setEnabled(true, 30);
  diagnostics.record('snapshot', 40, { tick: 4 });
  diagnostics.setEnabled(false, 50);
  const stopped = diagnostics.snapshot(50);
  diagnostics.record('snapshot', 60, { tick: 8 });
  const later = diagnostics.snapshot(200000);
  assert.deepEqual(later.samples, stopped.samples);
  assert.equal(later.collecting, false);
  assert.equal(later.stoppedAtMs, 50);
  diagnostics.setEnabled(true, 200010);
  const resumed = diagnostics.snapshot(200010);
  assert.equal(resumed.collecting, true);
  assert.equal(resumed.startedAtMs, 200010);
  assert.equal(resumed.stoppedAtMs, null);
  assert.deepEqual(
    resumed.samples.map((sample) => sample.kind),
    ['collection'],
  );
  assert.equal(new MatchDiagnostics().enabled, false);
});
