import test from 'node:test';
import assert from 'node:assert/strict';
import { Prediction } from '../../src/prediction/model';
import type { PredictionTrace } from '../../src/prediction/diagnostics';
import { PREDICTION_TRACE_LIMITS } from '../../src/prediction/diagnostics';
import { createCollisionGrid, resolveGrid } from '../../src/core/grid';
import { own, snap, welcome } from '../support/online';

const contactArena = {
  ...welcome,
  arena: { ...welcome.arena, walls: [{ x: 0, y: 0, w: 1, h: 20 }] },
};

const input = {
  x: 1,
  y: 0,
  aim: { x: 10, y: 4 },
  fire: false,
  secondary: false,
  grenade: false,
  molotov: false,
  pickup: 0,
};

void test('tracing preserves prediction, shots, pending input and RNG while capturing player/grid contacts', () => {
  const traces: PredictionTrace[] = [];
  const observed = new Prediction(contactArena),
    plain = new Prediction(contactArena);
  const state = snap(480);
  state.players[0]!.state.x = 1.31;
  state.local!.state.x = 1.31;
  state.local!.state.vx = -2;
  state.players.push({ ...own(), id: 2, state: { ...own().state, x: 1.7, y: 4 } });
  const saved = structuredClone(state);
  observed.reconcile(state, true, (e) => traces.push(e));
  plain.reconcile(state, true);
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(
      observed.advance(input, undefined, (e) => traces.push(e)),
      plain.advance(input),
    );
    assert.deepEqual(observed.player, plain.player);
    assert.deepEqual(observed.pending, plain.pending);
    assert.deepEqual(observed.seed, plain.seed);
  }
  const next = structuredClone(state);
  next.tick += 4;
  next.local!.ack = 2;
  observed.reconcile(next, true, (e) => traces.push(e));
  plain.reconcile(next, true);
  assert.deepEqual(observed.player, plain.player);
  assert.deepEqual(observed.seed, plain.seed);
  assert.equal(observed.correction, plain.correction);
  assert.deepEqual(state, saved, 'recording and collision replay must not mutate authority');
  const advanced = traces.filter((e) => e.kind === 'advance');
  assert.ok(
    advanced.some((e) => e.step.collisions.some((c) => c.kind === 'player' && c.other?.id === 2)),
  );
  assert.ok(advanced.some((e) => e.step.collisions.some((c) => c.kind === 'grid')));
  const reconciled = traces.at(-1)!;
  assert.equal(reconciled.kind, 'reconcile');
  if (reconciled.kind !== 'reconcile') return;
  assert.deepEqual(reconciled.pendingBefore, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    reconciled.replayInputs.map((c) => c.seq),
    [3, 4, 5, 6, 7, 8],
  );
  assert.equal(reconciled.previousAck, 0);
  assert.equal(reconciled.ack, 2);
  assert.equal(reconciled.previousTick, 480);
  assert.ok(reconciled.replayContacts.length > 0);
  assert.ok(reconciled.nearby.some((p) => p.id === 2));
  const detached = JSON.stringify(traces);
  observed.player!.equipment.heat = 999;
  observed.pending[0] = { ...observed.pending[0]!, aim: { x: 999, y: 999 } };
  next.players[0]!.state.x = 999;
  assert.equal(
    JSON.stringify(traces),
    detached,
    'later simulation/input changes cannot rewrite evidence',
  );
});

void test('respawn is a non-comparable transition, not a correction; duplicate snapshots emit nothing', () => {
  const p = new Prediction(contactArena),
    traces: PredictionTrace[] = [];
  const observe = (e: PredictionTrace) => traces.push(e);
  p.reconcile(snap(1), true, observe);
  const respawn = snap(2);
  respawn.players[0]!.life++;
  respawn.players[0]!.state.x += 5;
  respawn.local!.state.x += 5;
  p.reconcile(respawn, true, observe);
  p.reconcile(respawn, true, observe);
  assert.equal(traces.length, 2);
  assert.ok(traces.every((e) => e.kind === 'reconcile' && e.correction === null && !e.comparable));
  p.advance(input);
  assert.equal(traces.length, 2, 'no observer means no retained trace');
});

void test('grid observer sees the net wall response including early-return paths without changing it', () => {
  const grid = createCollisionGrid({ x: 0, y: 0, w: 20, h: 20 }, []);
  for (const body of [
    { x: 1.1, y: 4, vx: -2, vy: 0 },
    { x: -1, y: -1, vx: 0, vy: 0 },
    { x: 5, y: 5, vx: 0, vy: 0 },
  ]) {
    const plain = { ...body },
      traced = { ...body };
    const changes: unknown[] = [];
    resolveGrid(plain, body.x, body.y, grid, 0.25, 0.45, 0.05);
    resolveGrid(traced, body.x, body.y, grid, 0.25, 0.45, 0.05, (before, after) =>
      changes.push({ before, after }),
    );
    assert.deepEqual(traced, plain);
    assert.equal(changes.length, JSON.stringify(plain) === JSON.stringify(body) ? 0 : 1);
  }
});

void test('dense contacts and long replay have explicit trace truncation without limiting simulation', () => {
  const p = new Prediction(contactArena),
    plain = new Prediction(contactArena);
  const state = snap(480);
  state.players[0]!.state.x = 1.31;
  state.local!.state.x = 1.31;
  for (let i = 0; i < 40; i++)
    state.players.push({ ...own(), id: i + 2, state: { ...own().state, x: i % 2 ? 1.7 : 1.69 } });
  p.reconcile(state);
  plain.reconcile(state);
  for (let i = 0; i < 60; i++) {
    p.advance(input);
    plain.advance(input);
  }
  const next = { ...state, tick: 484 };
  let trace: PredictionTrace | undefined;
  p.reconcile(next, true, (e) => (trace = e));
  plain.reconcile(next, true);
  assert.deepEqual(p.player, plain.player);
  assert.ok(trace?.kind === 'reconcile');
  assert.equal(trace.nearby.length, PREDICTION_TRACE_LIMITS.nearby);
  assert.ok(trace.omittedNearby > 0);
  assert.equal(trace.replayContacts.length, PREDICTION_TRACE_LIMITS.replayContacts);
  assert.ok(trace.omittedReplayContacts > 0);
  assert.ok(trace.replayContacts.some((s) => s.omittedCollisions > 0));
  assert.ok(
    trace.replayContacts.every((s) => s.collisions.length <= PREDICTION_TRACE_LIMITS.collisions),
  );
});
