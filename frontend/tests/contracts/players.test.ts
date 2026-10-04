import { encodeDelivery } from '../support/encoding';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServerMessage, parseDelivery } from '../../src/network/protocol';
import { restoreSnapshot } from '../../src/contracts/snapshot';
import { Prediction } from '../../src/prediction/model';
import { OnlineSession } from '../../src/apps/match/session';
import { OnlineView } from '../../src/apps/match/view';
import { SHOTGUN, PHOTON, KNIVES } from '../../src/gameconfig/tuning';
import { knifeExtension } from '../../src/presentation/actors/knife-state';
import type { PredictionTrace } from '../../src/prediction/diagnostics';
import { own, remote, snap, welcome } from '../support/online';

void test('owner checkpoint requires every mechanics field; remotes reject simulation internals', () => {
  const state = snap(480);
  // Map replacement may carry a negative death tick to preserve respawn eligibility.
  state.local!.diedTick = -108;
  assert.doesNotThrow(() => parseServerMessage(JSON.stringify(state)));
  for (const key of Object.keys(state.local!.state)) {
    const bad = structuredClone(state);
    Reflect.deleteProperty(bad.local!.state, key);
    assert.throws(() => parseServerMessage(JSON.stringify(bad)), /Malformed/, key);
  }
  for (const key of Object.keys(state.local!.state.equipment)) {
    const bad = structuredClone(state);
    Reflect.deleteProperty(bad.local!.state.equipment, key);
    assert.throws(() => parseServerMessage(JSON.stringify(bad)), /Malformed/, key);
  }
  for (const extra of [{ vx: 0 }, { vy: 0 }, { spread: 1 }]) {
    const bad = structuredClone(state);
    Object.assign(bad.players[0]!.state, extra);
    assert.throws(() => parseServerMessage(JSON.stringify(bad)), /Malformed/);
  }
  for (const key of ['ack', 'seed']) {
    const bad = structuredClone(state);
    Object.assign(bad.players[0]!, { [key]: 1 });
    assert.throws(() => parseServerMessage(JSON.stringify(bad)), /Malformed/);
  }
});

void test('identity changes require a fresh installation and cannot reuse local mechanics', () => {
  const state = snap(480);
  const other = snap(484, { ...own(), id: 2 });
  assert.throws(() => restoreSnapshot(other, state), /identity/);
  const prediction = new Prediction(welcome);
  assert.throws(() => prediction.reconcile(other), /local checkpoint/);
  assert.equal(prediction.lastTick, -1);
  assert.ok(new Prediction({ ...welcome, id: 2 }).reconcile(restoreSnapshot(other, null)));
  const frame = {
    type: 'delivery',
    version: welcome.version,
    connection: 'test',
    sequence: 1,
    generation: 1,
    eventThrough: 0,
    sentAtMs: 4000,
    kind: 'installation',
    body: { ...welcome, tick: 480, state },
  };
  assert.doesNotThrow(() => parseDelivery(encodeDelivery(frame)));
  for (const local of [null, { ...state.local, id: 2 }])
    assert.throws(
      () =>
        parseDelivery(
          encodeDelivery({ ...frame, body: { ...frame.body, state: { ...state, local } } }),
        ),
      /Malformed|does not match/,
    );
});

void test('remote contacts and diagnostics use exact positions without invented velocities', () => {
  const state = snap(480);
  const other = remote({ ...own(), id: 2 });
  other.state.x = 4.1;
  state.players.push(other);
  const saved = structuredClone(state);
  const prediction = new Prediction(welcome);
  const traces: PredictionTrace[] = [];
  prediction.reconcile(state, true, (t) => traces.push(t));
  const trace = traces[0]!;
  assert.equal(trace.kind, 'reconcile');
  if (trace.kind !== 'reconcile') return;
  assert.deepEqual(trace.nearby[0]!.state, { x: 4.1, y: 4 });
  prediction.advance({ x: 0, y: 0, aim: { x: 10, y: 4 }, fire: false });
  assert.ok(prediction.player!.x < 4, 'remote contact must push local body away');
  assert.deepEqual(state, saved);
});

void test('remote reload, charge, recoil, shield and knives retain their presentation inputs', () => {
  const state = snap(480);
  const other = remote({ ...own(), id: 2 });
  other.state.cooldown = SHOTGUN.reloadSeconds / 2;
  Object.assign(other.state.equipment, {
    primary: 'shotgun',
    secondary: 'knives',
    shells: SHOTGUN.shells,
    charge: PHOTON.chargeSeconds / 2,
    sinceShot: 0.123,
    protection: 1,
    meleeDelay: KNIVES.cooldownSeconds / 2,
  });
  state.players.push(other);
  const decoded = parseServerMessage(JSON.stringify(state));
  assert.equal(decoded.type, 'snapshot');
  if (decoded.type !== 'snapshot') return;
  const session = new OnlineSession(welcome);
  session.receive(decoded, 4000, 4000);
  const actor = new OnlineView().compose(session, { x: 10, y: 4 }, 4000, 0, true, 0, 0).actors[0]!;
  assert.equal(actor.weapon!.reload, 0.5);
  assert.equal(actor.weapon!.charge, 0.5);
  assert.equal(actor.weapon!.shotAge, 0.123);
  assert.equal(actor.shield, true);
  assert.equal(actor.knives, knifeExtension(KNIVES.cooldownSeconds / 2, KNIVES.cooldownSeconds));
  assert.equal(actor.primary, 'shotgun');
});

void test('spectator, death, respawn and map replacement keep full local state and discard stale inputs', () => {
  const session = new OnlineSession(welcome);
  const p = own();
  p.state.vx = 1.123456789;
  p.state.equipment.heat = 0.3456789123;
  let tick = 480;
  for (const status of ['spectator', 'alive', 'dead', 'alive'] as const) {
    p.status = status;
    p.life++;
    p.ack += 3;
    p.seed += 7;
    const s = snap((tick += 4), structuredClone(p));
    session.receive(s, (tick * 1000) / 120, s.capturedAtMs);
    assert.deepEqual(session.prediction.player, p.state);
    assert.equal(session.prediction.own!.ack, p.ack);
    assert.equal(session.prediction.seed.seed, p.seed);
    assert.equal(session.prediction.pending.length, 0);
    session.prediction.advance({ x: 1, y: 0, aim: { x: 10, y: 4 }, fire: false });
  }
  const s = snap(tick + 4, p);
  s.match.round++;
  session.receive(s, 5000, s.capturedAtMs);
  assert.equal(session.prediction.pending.length, 0);
  assert.deepEqual(session.prediction.player, p.state);
});
