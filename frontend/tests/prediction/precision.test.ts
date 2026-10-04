import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL } from '../../src/contracts/session';
import type { Snapshot } from '../../src/contracts/session';
import { restoreSnapshot } from '../../src/contracts/snapshot';
import { parseDelivery } from '../../src/network/protocol';
import { Prediction, Interpolation } from '../../src/prediction/model';
import { own, remote, snap, welcome } from '../support/online';
import { encodeDelivery } from '../support/encoding';

function transmitted(snapshot: Snapshot): Snapshot {
  const message = parseDelivery(
    encodeDelivery({
      type: 'delivery',
      version: PROTOCOL,
      connection: 'precision',
      sequence: 1,
      generation: 1,
      eventThrough: snapshot.eventCut,
      sentAtMs: snapshot.capturedAtMs,
      kind: 'state',
      body: {
        ...snapshot,
        items: { upsert: [], remove: [] },
        projectiles: { upsert: [], remove: [] },
      },
    }),
  );
  assert.equal(message.kind, 'state');
  if (message.kind !== 'state') throw new Error('Expected state');
  return restoreSnapshot(message.body, snapshot);
}

void test('full installation to quantized state preserves local reconciliation and circular interpolation', () => {
  const local = own();
  local.state.x = 4.123456789;
  const other = own();
  other.id = 2;
  other.state.x = 8.123456789;
  other.state.angle = Math.PI - 0.00001;
  const initial = snap(400, local);
  initial.players.push(remote(other));
  const update = structuredClone(initial);
  update.tick += 12;
  update.capturedAtMs = Math.floor((update.tick * 1000) / 120);
  update.players[1]!.state.angle = -Math.PI + 0.00001;
  const decoded = transmitted(update);
  assert.deepEqual(decoded.local, update.local);
  assert.ok(Math.abs(decoded.players[1]!.state.x - other.state.x) <= 1 / 8192);
  const prediction = new Prediction(welcome);
  prediction.reconcile(initial);
  prediction.reconcile(decoded, true);
  assert.deepEqual(prediction.player, local.state);
  assert.equal(prediction.correction, 0);
  const buffer = new Interpolation();
  buffer.push(initial, 0);
  buffer.push(decoded, 100);
  const rendered = buffer.players(150, 120).find((p) => p.id === 2)!;
  assert.equal(buffer.view(150, 120)?.alpha, 0.5);
  assert.ok(
    Math.abs(Math.abs(rendered.state.angle) - Math.PI) < 0.0001,
    'angle wrap took the long arc',
  );
  assert.ok(Math.abs(rendered.state.x - other.state.x) <= 1 / 8192);
  assert.equal(initial.players[1]!.state.x, other.state.x, 'installation was mutated');
});

void test('quantized remote contact stays bounded during advance and unacknowledged input replay', () => {
  for (const offset of [-1 / 8192, 0, 1 / 8192]) {
    const local = own();
    const other = own();
    other.id = 2;
    other.state.x = 4.7 + offset;
    const initial = snap(400, local);
    initial.players.push(remote(other));
    const decoded = transmitted(initial);
    const exact = new Prediction(welcome),
      quantized = new Prediction(welcome);
    exact.reconcile(initial);
    quantized.reconcile(decoded);
    const input = { x: 1, y: 0, aim: { x: 10, y: 4 }, fire: false };
    for (let tick = 0; tick < 50; tick++) {
      exact.advance(input);
      quantized.advance(input);
      assert.ok(Math.abs(exact.player!.x - quantized.player!.x) <= 1 / 8192 + 1e-12);
      assert.ok(quantized.player!.x <= decoded.players[1]!.state.x - 0.5 + 1e-12);
    }
    exact.reconcile({ ...initial, tick: 404 });
    quantized.reconcile({ ...decoded, tick: 404 });
    assert.ok(Math.abs(exact.player!.x - quantized.player!.x) <= 1 / 8192 + 1e-12);
    assert.equal(initial.players[1]!.state.x, other.state.x);
  }
});
