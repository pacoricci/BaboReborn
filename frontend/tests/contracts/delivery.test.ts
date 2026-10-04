import { encodeDelivery } from '../support/encoding';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDelivery, parseServerMessage } from '../../src/network/protocol';
import { AuthorityClock } from '../../src/network/clock';
import { OnlineLifecycle } from '../../src/apps/match/lifecycle';
import { OnlineSession } from '../../src/apps/match/session';
import { PROTOCOL } from '../../src/contracts/session';
import type { Delivery, Receipt } from '../../src/contracts/session';
import { welcome, own, snap, batch, eventHeader } from '../support/online';

void test('delivery validation binds installation to its checkpoint and bounds frame size', () => {
  const frame = {
    type: 'delivery',
    version: welcome.version,
    connection: 'one',
    sequence: 1,
    generation: 1,
    eventThrough: 0,
    sentAtMs: 100,
    kind: 'installation',
    body: { ...welcome, state: snap(0) },
  };
  assert.deepEqual(parseDelivery(encodeDelivery(frame)), frame);
  for (const patch of [
    { version: welcome.version - 1 },
    { generation: 0 },
    { sequence: 0 },
    { sequence: 1.5 },
    { body: { ...frame.body, state: snap(1) } },
    { kind: 'state' },
    { body: { ...frame.body, state: { ...snap(0), capturedAtMs: 101 } } },
    { connection: 'x'.repeat(129) },
  ])
    assert.throws(() => parseDelivery(encodeDelivery({ ...frame, ...patch })));
  assert.throws(() => parseDelivery(' '.repeat(2 * 1024 * 1024 + 1)));
  assert.throws(() => parseDelivery(encodeDelivery(snap(0))));
});

void test('only ordered state deliveries may omit items; installation and complete snapshots cannot', () => {
  const state = { ...snap(0), items: undefined, projectiles: undefined };
  const frame = {
    type: 'delivery',
    version: PROTOCOL,
    connection: 'items',
    sequence: 2,
    generation: 1,
    eventThrough: 0,
    sentAtMs: 100,
    kind: 'state',
    body: state,
  };
  assert.equal(parseDelivery(encodeDelivery(frame)).kind, 'state');
  assert.throws(() => parseServerMessage(JSON.stringify(state)));
  assert.throws(() => parseDelivery(encodeDelivery({ ...frame, body: { ...state, items: null } })));
  assert.throws(() =>
    parseDelivery(encodeDelivery({ ...frame, kind: 'installation', body: { ...welcome, state } })),
  );
  for (const items of [
    [],
    [
      {
        id: 1,
        kind: 'grenade',
        motion: 'fixed',
        motionTick: 0,
        expiresTick: 100,
        velocity: { x: 0, y: 0, z: 0 },
        position: { x: 4, y: 4, z: 0.1 },
      },
    ],
  ])
    assert.equal(
      parseDelivery(
        encodeDelivery({ ...frame, body: { ...state, items: { upsert: items, remove: [] } } }),
      ).kind,
      'state',
    );
});

void test('probe clock excludes server residence and exposes asymmetric latency uncertainty', () => {
  const clock = new AuthorityClock();
  assert.equal(clock.time(0).upper, Infinity);
  // Client->server 20 ms, server residence 100 ms, server->client 80 ms, offset 1000 ms.
  clock.observe(10, 210, 1030, 1130);
  assert.equal(clock.rtt, 100);
  assert.equal(clock.time(210).now, 1180);
  assert.equal(clock.time(210).upper, 1230);
  assert.deepEqual(clock.diagnostics(210), {
    offsetLowMs: 920,
    offsetHighMs: 1020,
    clockSampleAtMs: 210,
  });
  clock.observe(210, 200, 1200, 1201); // Invalid sample cannot rewrite the clock.
  assert.equal(clock.rtt, 100);
  assert.equal(clock.time(30211).upper, Infinity);
  assert.deepEqual(clock.diagnostics(30211), {
    offsetLowMs: null,
    offsetHighMs: null,
    clockSampleAtMs: null,
  });
});

void test('late or unknown authority time suppresses visuals but preserves required event processing', () => {
  for (const authority of [
    { now: 2000, upper: 2050 },
    { now: Infinity, upper: Infinity },
  ]) {
    const session = new OnlineSession(welcome);
    session.receive({ ...snap(120), eventCut: 1, capturedAtMs: 1000 }, 2000, authority.now);
    const fact = { ...eventHeader(1, 120), kind: 'hit' as const, action: 1, occurredAtMs: 1000 };
    const cue = {
      ...eventHeader(1, 120),
      kind: 'explosion' as const,
      radius: 1,
      occurredAtMs: 1000,
    };
    const change = session.receiveEvents(batch(120, [fact], [cue]), 2000, authority.upper);
    assert.equal(change.accepted.length, 1);
    assert.equal(change.events.length, 0);
    assert.equal(change.cues.length, 0);
    assert.equal(session.eventThrough, 1);
    session.advance({ x: 1, y: 0, aim: { x: 10, y: 4 }, fire: false }, 0.1, 2000, true, () => {});
    assert.equal(session.prediction.pending.length, 0);
  }
});

void test('steady latency preserves interpolated motion and a large checkpoint gap resets it', () => {
  const session = new OnlineSession(welcome);
  for (let i = 0; i <= 6; i++) {
    const player = own();
    player.state.x = i;
    const state = snap(i * 4, player);
    session.receive(state, state.capturedAtMs + 1150, state.capturedAtMs + 150);
  }
  const before = session.interpolation.players(1366, 120)[0]!.state.x;
  const after = session.interpolation.players(1382, 120)[0]!.state.x;
  assert.ok(before < after && after < 6, 'latency must not disable the interpolation buffer');
  const player = own();
  player.state.x = 10;
  session.receive(snap(120, player), 2150, 1150);
  assert.equal(session.interpolation.players(2150, 120)[0]!.state.x, 10);
});

void test('Go delivery fixture passes the browser lifecycle and produces exact processing receipts', () => {
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL(
        `../../../backend/server/transport/testdata/v${PROTOCOL}-delivery.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.ok(Array.isArray(raw));
  const frames = raw.map((value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      'protobuf' in value &&
      typeof value.protobuf === 'string'
    )
      return parseDelivery(Buffer.from(value.protobuf, 'base64'));
    return parseDelivery(JSON.stringify(value));
  });
  for (const frame of frames) {
    if (frame.kind === 'state') assert.equal('activities' in frame.body, false);
    if (frame.kind === 'installation') {
      assert.ok(Array.isArray(frame.body.activities));
      assert.equal('activities' in frame.body.state, false);
      if (frame.body.type === 'welcome') assert.equal(frame.body.activities.length, 1);
      if (frame.body.type === 'resync') assert.equal(frame.body.activities.length, 2);
    }
  }
  const receipts: Receipt[] = [];
  const accepted: number[] = [];
  const cues: number[] = [];
  const notices: string[] = [];
  const failures: string[] = [];
  const installations: string[] = [];
  const engine = { runRenderLoop() {}, stopRenderLoop() {}, dispose() {} };
  const lifecycle = new OnlineLifecycle({
    now: () => 100,
    frame() {},
    loading() {},
    loaded() {},
    snapshot() {},
    initialized(message) {
      installations.push(message.type);
    },
    events(change) {
      accepted.push(...change.accepted.map((event) => event.id));
      cues.push(...change.cues.map((cue) => cue.id));
    },
    administration(notice) {
      notices.push(notice.action);
    },
    failed(message) {
      failures.push(message);
    },
    createEngine: () => engine,
    createRenderer: () => ({ engine, scene: { dispose() {} } }),
  });
  let receive!: (frame: Delivery) => void;
  lifecycle.connect((handlers) => {
    receive = (frame) =>
      handlers.message(frame, frame.sentAtMs + 1000, {
        now: frame.sentAtMs,
        upper: frame.sentAtMs,
      });
    return {
      connected: true,
      rtt: 0,
      payloadBytesIn: 0,
      payloadBytesOut: 0,
      webSocketExtensions: '',
      close() {},
      send(message) {
        if (message.type === 'receipt') receipts.push(message.receipt);
      },
    };
  });
  try {
    for (const frame of frames) receive(frame);
    assert.deepEqual(
      receipts,
      frames.map((frame) => ({
        connection: frame.connection,
        sequence: frame.sequence,
        generation: frame.generation,
        eventThrough: frame.eventThrough,
      })),
    );
    assert.deepEqual(
      new Set(frames.map((frame) => frame.kind)),
      new Set(['installation', 'state', 'events', 'cues', 'control', 'probe']),
    );
    assert.deepEqual(installations, ['welcome', 'resync', 'map']);
    assert.deepEqual(accepted, [2, 3, 4, 5]);
    assert.deepEqual(cues, [1]);
    assert.deepEqual(notices, ['permissions_changed']);
    assert.equal(lifecycle.session?.welcome.round, 2);
    assert.equal(lifecycle.session?.eventThrough, 5);
    assert.deepEqual(failures, []);
  } finally {
    lifecycle.dispose();
  }
});
