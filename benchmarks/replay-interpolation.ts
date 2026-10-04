// Offline temporal replay; synthetic positions cannot establish human gameplay feel.
import { readFileSync } from 'node:fs';
import { Interpolation } from '../frontend/src/prediction/model';
import { snap, own } from '../frontend/tests/support/online';

interface Event {
  kind: string;
  atMs: number;
  data: {
    tick: number;
    round: number;
    generation: number;
    capturedAtMs: number;
    sourceAgeMs: number | null;
    active: boolean;
  };
}
const file = process.argv[2];
if (!file)
  throw new Error('Usage: node --import tsx benchmarks/replay-interpolation.ts REPORT.json');
const report = JSON.parse(readFileSync(file, 'utf8')) as {
  tickHz: number;
  timeline: { samples: Event[] };
};
const hz = report.tickHz;
const history: { tick: number; at: number; captured: number; age: number | null }[] = [];
let buffer = new Interpolation(),
  generation = -1;
const temporalErrors: number[] = [],
  deltas: number[] = [],
  sourceAges: number[] = [];
let starvedFrames = 0,
  staleEndpoints = 0;
let previous: { at: number; tick: number } | undefined;
for (const event of report.timeline.samples) {
  const now = event.atMs,
    d = event.data;
  if (event.kind === 'snapshot') {
    if (d.generation !== generation || (history.at(-1) && d.tick - history.at(-1)!.tick > 60)) {
      buffer = new Interpolation();
      history.length = 0;
      previous = undefined;
      generation = d.generation;
    }
    const player = own();
    player.state.x = d.tick / hz;
    const state = snap(d.tick, player);
    state.match.round = d.round;
    buffer.push(state, now);
    history.push({ tick: d.tick, at: now, captured: d.capturedAtMs, age: d.sourceAgeMs });
    if (history.length > 32) history.shift();
  }
  if (event.kind !== 'frame' || !history.length) continue;
  const latest = history.at(-1)!,
    first = history[0]!;
  const view = buffer.view(now, hz)!;
  const tick = view.from + (view.to - view.from) * view.alpha;
  if (d.active && previous) {
    const delta = ((tick - previous.tick) * 1000) / hz;
    deltas.push(delta);
    temporalErrors.push(Math.abs(delta - (now - previous.at)));
    starvedFrames += Number(buffer.diagnostics(now, hz).starved);
    if (latest.age !== null) {
      const sourceNow = latest.captured + latest.age + now - latest.at;
      let a = first,
        b = latest;
      for (const sample of history) {
        if (sample.tick <= tick) a = sample;
        if (sample.tick >= tick) {
          b = sample;
          break;
        }
      }
      staleEndpoints += Number(sourceNow - a.captured > 250);
      const alpha = (tick - a.tick) / (b.tick - a.tick || 1);
      sourceAges.push(sourceNow - (a.captured + (b.captured - a.captured) * alpha));
    }
  }
  previous = { at: now, tick };
}
const quantile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    i = (sorted.length - 1) * p,
    low = Math.floor(i);
  return sorted[low]! + (sorted[Math.ceil(i)]! - sorted[low]!) * (i - low);
};
console.log(
  JSON.stringify(
    {
      file,
      frames: deltas.length,
      reverseFrames: deltas.filter((d) => d < -1e-6).length,
      frozenFrames: deltas.filter((d) => Math.abs(d) < 1e-6).length,
      starvedFrames,
      temporalErrorP99Ms: quantile(temporalErrors, 0.99),
      maximumAdvanceMs: deltas.length ? Math.max(...deltas) : null,
      estimatedEndpointOver250Ms: staleEndpoints,
      sourceAgeMs: {
        mean: sourceAges.length ? sourceAges.reduce((a, b) => a + b, 0) / sourceAges.length : null,
        p95: quantile(sourceAges, 0.95),
        max: sourceAges.length ? Math.max(...sourceAges) : null,
      },
      scope: 'Temporal replay, not measured remote trajectories or expired shots.',
    },
    null,
    2,
  ),
);
