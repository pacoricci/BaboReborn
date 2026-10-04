import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchDiagnostics } from '../../src/apps/match/diagnostic-history';
import { Prediction } from '../../src/prediction/model';
import type { PredictionTrace } from '../../src/prediction/diagnostics';
import { snap, welcome } from '../support/online';

function trace(correction = 0): PredictionTrace {
  const p = new Prediction(welcome);
  p.reconcile(snap(1));
  const next = snap(2);
  next.players[0]!.state.x += correction;
  next.local!.state.x += correction;
  let result!: PredictionTrace;
  p.reconcile(next, true, (e) => (result = e));
  return result;
}

void test('episodes capture one second before/after, group triggers and report early exports', () => {
  const d = new MatchDiagnostics();
  d.setEnabled(true, 0);
  const quiet = trace(),
    correction = trace(0.1);
  for (let t = 0; t < 1500; t += 20) d.predictionObserver(t, 1)!(quiet);
  d.predictionObserver(1500, 1)!(correction);
  const early = d.snapshot(1500).corrections;
  assert.equal(early.episodes.length, 1);
  assert.equal(early.episodes[0]!.samples[0]!.atMs, 500);
  assert.equal(early.episodes[0]!.samples.at(-1)!.atMs, 1500);
  assert.equal(early.episodes[0]!.afterComplete, false);
  d.predictionObserver(1800, 1)!(correction);
  d.predictionObserver(2500, 1)!(quiet);
  const finished = d.snapshot(2500).corrections.episodes[0]!;
  assert.equal(finished.afterComplete, true);
  assert.equal(finished.triggers, 2);
  assert.equal(finished.samples.at(-1)!.atMs, 2500);
  assert.equal(
    early.episodes[0]!.samples.at(-1)!.atMs,
    1500,
    'exports are not extended by later collection',
  );
});

void test('bounded detail retains newest episodes, reports loss and expires separately from timeline', () => {
  const d = new MatchDiagnostics();
  d.setEnabled(true, 0);
  const quiet = trace(),
    correction = trace(0.1);
  for (let t = 0; t < 300; t++) d.predictionObserver(t, 1)!(quiet);
  d.predictionObserver(300, 1)!(correction);
  for (let t = 301; t <= 1300; t++) d.predictionObserver(t, 1)!(quiet);
  let history = d.snapshot(1300).corrections;
  assert.ok(history.recentCapacityEvictions > 0);
  assert.equal(history.episodes[0]!.samples.length, history.episodeSampleCapacity);
  assert.ok(history.episodes[0]!.omittedSamples > 0);
  for (let i = 1; i <= 10; i++) d.predictionObserver(2000 * i, 1)!(correction);
  history = d.snapshot(20000).corrections;
  assert.equal(history.episodes.length, history.episodeCapacity);
  assert.equal(history.episodeEvictions, 3);
  assert.equal(
    d.snapshot(20000).samples.length,
    1,
    'details cannot consume the network/frame ring',
  );
  assert.equal(d.snapshot(141001).corrections.episodes.length, 0);
});

void test('disabled collection has no observer, freezes details and marks interrupted windows across resume', () => {
  const d = new MatchDiagnostics();
  assert.equal(d.predictionObserver(0, 1), undefined);
  d.setEnabled(true, 0);
  d.predictionObserver(100, 1)!(trace(0.1));
  d.setEnabled(false, 200);
  const stopped = d.snapshot(200).corrections;
  assert.equal(stopped.episodes[0]!.interrupted, 'collection');
  assert.equal(stopped.recent.length, 1);
  assert.equal(d.predictionObserver(300, 1), undefined);
  assert.deepEqual(d.snapshot(500000).corrections, stopped);
  d.setEnabled(true, 600);
  d.predictionObserver(700, 1)!(trace(0.2));
  const resumed = d.snapshot(700).corrections;
  assert.equal(resumed.episodes.length, 2);
  assert.deepEqual(
    resumed.episodes[1]!.samples.map((s) => s.atMs),
    [700],
  );
});
