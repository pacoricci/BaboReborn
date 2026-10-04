import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineLifecycle } from '../../src/apps/match/lifecycle';
import type { ServerMessage, Delivery, AuthorityTime } from '../../src/contracts/session';
import type { Activity } from '../../src/contracts/activity';
import { welcome, snap, batch, eventHeader } from '../support/online';

function fixture(failRound = 0) {
  const log: string[] = [];
  const frame = () => {};
  const loops = new Set<() => void>();
  const accepted: number[] = [];
  const played: number[] = [];
  const engine = {
    runRenderLoop(callback: () => void) {
      log.push('start');
      loops.add(callback);
    },
    stopRenderLoop(callback: () => void) {
      log.push('stop');
      loops.delete(callback);
    },
    dispose() {
      log.push('dispose-engine');
    },
  };
  type Renderer = { engine: typeof engine; scene: { dispose(): void } };
  let events!: Parameters<Parameters<OnlineLifecycle<Renderer>['connect']>[0]>[0];
  const lifecycle = new OnlineLifecycle<Renderer>({
    now: () => 100,
    frame,
    closed() {
      log.push('remote-close');
      return false;
    },
    events(change) {
      log.push('events');
      accepted.push(...change.accepted.map((e) => e.id));
      played.push(...change.events.map((e) => e.id));
    },
    createEngine() {
      log.push('create-engine');
      return engine;
    },
    createRenderer(message, reused) {
      assert.equal(reused, engine);
      assert.equal(loops.size, 0, 'the old frame loop must stop before constructing a scene');
      log.push(`create-${message.round}`);
      if (message.round === failRound) throw new Error('Scene construction failed.');
      return {
        engine: reused,
        scene: {
          dispose() {
            log.push(`dispose-${message.round}`);
          },
        },
      };
    },
    loading() {
      log.push('clear-input-and-feedback');
    },
    initialized(message) {
      assert.equal(lifecycle.session?.welcome, message);
      log.push(`initialize-${message.type}`);
    },
    loaded() {
      log.push('loaded');
    },
    snapshot() {
      log.push('snapshot');
    },
    failed(message) {
      log.push(`failure:${message}`);
    },
  });
  lifecycle.connect((handlers) => {
    events = handlers;
    return {
      connected: true,
      rtt: 0,
      payloadBytesIn: 0,
      payloadBytesOut: 0,
      webSocketExtensions: '',
      send(message) {
        log.push(`send-${message.type}`);
      },
      close() {
        log.push('close');
        events.closed(1000, '');
      },
    };
  });
  let sequence = 0,
    generation = 0,
    through = 0;
  const emitFrame = (frame: Delivery, now: number, time: AuthorityTime) => {
    try {
      events.message(frame, now, time);
    } catch (error) {
      events.invalid(error);
    }
  };
  const emit = (message: ServerMessage) => {
    const install =
      message.type === 'welcome' || message.type === 'map' || message.type === 'resync';
    if (install) {
      generation++;
      if (generation === 1) through = message.eventCut;
    }
    if (message.type === 'events') through = message.through;
    const state = install
      ? {
          ...snap(message.tick),
          eventCut: message.eventCut,
          match: { ...snap(message.tick).match, round: message.round },
        }
      : null;
    const body = install ? { ...message, state } : message;
    emitFrame(
      {
        type: 'delivery',
        version: welcome.version,
        connection: 'test',
        sequence: ++sequence,
        generation,
        eventThrough: through,
        sentAtMs: 100,
        kind: install
          ? 'installation'
          : message.type === 'snapshot'
            ? 'state'
            : message.type === 'events'
              ? 'events'
              : 'control',
        body,
      } as Delivery,
      100,
      { now: 100, upper: 100 },
    );
  };
  return { lifecycle, log, emit, emitFrame, events, loops, accepted, played };
}

void test('installation restores activity history while reliable replay neither duplicates nor extends it', () => {
  const f = fixture();
  const activity = (id: number): Activity => ({
    id,
    tick: id,
    round: 1,
    occurredAtMs: 0,
    kind: 'connected',
    actor: { id, nickname: `Player ${id}`, team: 'none' },
  });
  const first = activity(1),
    second = activity(2),
    third = activity(3);
  f.emit({ ...welcome, tick: 10, eventCut: 1, activities: [first] });
  const rows = () => f.lifecycle.session!.activityFeed.visible(100).map((row) => row.event.id);
  assert.deepEqual(rows(), [1]);
  f.emit({ ...snap(20), eventCut: 2 });
  assert.deepEqual(rows(), [1], 'ordinary snapshots do not replace the feed');
  f.emit(batch(20, [{ ...eventHeader(2, 2), kind: 'activity', activity: second }], [], 1));
  assert.deepEqual(rows(), [1, 2]);
  f.emit({ ...welcome, type: 'resync', tick: 30, eventCut: 3, activities: [first, second, third] });
  assert.deepEqual(rows(), [1, 2, 3]);
  assert.equal(
    f.lifecycle.session!.eventThrough,
    2,
    'history must not acknowledge an undelivered fact',
  );
  f.emit(batch(30, [{ ...eventHeader(3, 3), kind: 'activity', activity: third }], [], 2));
  assert.deepEqual(rows(), [1, 2, 3]);
  assert.deepEqual(f.accepted, [2, 3], 'required facts still traverse the event path');
  assert.equal(f.lifecycle.session!.activityFeed.visible(9999).length, 3);
  assert.equal(
    f.lifecycle.session!.activityFeed.visible(10000).length,
    0,
    'resync and replay do not restart expiry',
  );
  f.emit({ ...welcome, type: 'map', round: 2, tick: 40, eventCut: 3 });
  assert.deepEqual(rows(), [], 'old-round activity must not survive map installation');
  assert.equal(f.lifecycle.failure, '');
  f.lifecycle.dispose();
});

void test('events survive a newer checkpoint, duplicates and the map installation cut', () => {
  const f = fixture();
  f.emit(welcome);
  f.emit({ ...snap(20), eventCut: 1 });
  const delivery = batch(10, [{ ...eventHeader(1, 10), kind: 'hit', action: 1 }]);
  f.emit(snap(10)); // A stale checkpoint cannot roll state backwards.
  f.emit(delivery);
  f.emitFrame(
    {
      type: 'delivery',
      version: welcome.version,
      connection: 'test',
      sequence: 4,
      generation: 1,
      eventThrough: 1,
      sentAtMs: 100,
      kind: 'events',
      body: delivery,
    },
    100,
    { now: 100, upper: 100 },
  );
  assert.deepEqual(f.accepted, [1]);
  assert.equal(f.log.filter((e) => e === 'snapshot').length, 2);
  assert.equal(f.lifecycle.session!.latest!.tick, 20);
  f.emit({ ...welcome, type: 'map', round: 2, tick: 24, eventCut: 3 });
  assert.equal(f.lifecycle.session!.eventThrough, 1, 'map cut cannot skip owed events');
  const state = { ...snap(28), eventCut: 3 };
  state.match.round = 2;
  f.emit(state);
  f.emit(
    batch(
      28,
      [
        { ...eventHeader(2, 23), kind: 'phase', phase: 'intermission' },
        { ...eventHeader(3, 24), round: 2, kind: 'phase', phase: 'playing' },
      ],
      [],
      1,
    ),
  );
  assert.deepEqual(f.accepted, [1, 2, 3]);
  assert.deepEqual(f.played, [1, 3], 'old-round fact must not announce against the new map');
  assert.equal(f.lifecycle.session!.eventThrough, 3);
  assert.equal(f.lifecycle.failure, '');
  f.lifecycle.dispose();
});

void test('map replacement reuses one engine, clears feedback and disposes each old scene before restart', () => {
  const f = fixture();
  f.emit(welcome);
  assert.equal(f.lifecycle.ready, true);
  f.emit(snap(1));
  assert.equal(f.lifecycle.ready, true);
  f.lifecycle.session!.advance(
    { x: 1, y: 0, aim: { x: 8, y: 4 }, fire: false },
    1 / 60,
    101,
    true,
    () => {},
  );
  const previous = f.lifecycle.session!;
  f.log.length = 0;
  f.emit({ ...welcome, type: 'map', round: 2 });
  assert.deepEqual(f.log, [
    'clear-input-and-feedback',
    'stop',
    'dispose-1',
    'create-2',
    'start',
    'send-receipt',
    'initialize-map',
    'loaded',
    'snapshot',
  ]);
  assert.equal(previous.prediction.pending.length, 0);
  assert.equal(previous.batch(200), null);
  assert.equal(f.lifecycle.ready, true, 'installation includes its complete checkpoint');
  const next = snap(2);
  next.match.round = 2;
  f.emit(next);
  f.emit(next);
  assert.equal(
    f.log.filter((event) => event === 'snapshot').length,
    2,
    'stale snapshots cannot repeat effects/menu callbacks',
  );
  f.emit({ ...welcome, type: 'map', round: 3 });
  assert.equal(f.loops.size, 1);
  f.lifecycle.dispose();
  f.lifecycle.dispose();
  assert.equal(f.loops.size, 0);
  for (const event of ['dispose-1', 'dispose-2', 'dispose-3', 'dispose-engine', 'close'])
    assert.equal(f.log.filter((item) => item === event).length, 1, event);
  assert.ok(
    !f.log.some((item) => item.startsWith('failure:')),
    'teardown is not a disconnection error',
  );
  f.emit({ ...welcome, type: 'map', round: 4 });
  assert.equal(f.log.includes('create-4'), false);
});

for (const failRound of [1, 2])
  void test(`scene construction failure in round ${failRound} retains its engine for one teardown`, () => {
    const f = fixture(failRound);
    f.emit(welcome);
    if (failRound === 2) f.emit({ ...welcome, type: 'map', round: 2 });
    assert.equal(f.lifecycle.renderer, null);
    assert.equal(f.lifecycle.ready, false);
    assert.equal(f.lifecycle.failure, 'Scene construction failed.');
    assert.equal(f.loops.size, 0);
    f.events.closed(1000, 'Invalid server message');
    assert.equal(f.log.filter((event) => event.startsWith('failure:')).length, 1);
    f.lifecycle.dispose();
    f.lifecycle.dispose();
    assert.equal(f.log.filter((event) => event === 'dispose-engine').length, 1);
    assert.equal(f.log.filter((event) => event === 'create-engine').length, 1);
  });

void test('unexpected map identity or round and duplicate welcome cannot replace the current scene', () => {
  for (const bad of [
    welcome,
    { ...welcome, type: 'map' as const, id: 99, round: 2 },
    { ...welcome, type: 'map' as const, round: 1 },
  ]) {
    const f = fixture();
    f.emit(welcome);
    f.log.length = 0;
    const renderer = f.lifecycle.renderer;
    f.emit(bad);
    assert.equal(f.lifecycle.renderer, renderer);
    assert.ok(f.lifecycle.failure);
    assert.equal(
      f.log.some((event) => event.startsWith('dispose-')),
      false,
    );
    f.lifecycle.dispose();
  }
});

void test('same-round recovery resets replay without skipping required facts', () => {
  const f = fixture();
  f.emit(welcome);
  const renderer = f.lifecycle.renderer;
  f.emit({ ...snap(20), eventCut: 2 });
  f.lifecycle.session!.advance(
    { x: 1, y: 0, aim: { x: 8, y: 4 }, fire: false },
    1 / 60,
    100,
    true,
    () => {},
  );
  const inputSequence = f.lifecycle.session!.prediction.seq;
  assert.ok(inputSequence > 0);
  f.emit(batch(20, [{ ...eventHeader(1, 10), kind: 'hit', action: 1 }], [], 0));
  f.emit({ ...welcome, type: 'resync', tick: 24, eventCut: 2 });
  assert.equal(f.lifecycle.renderer, renderer, 'recovery must not rebuild the same map scene');
  assert.equal(f.log.includes('dispose-1'), false);
  assert.equal(f.lifecycle.session!.eventThrough, 1);
  f.emit(batch(24, [{ ...eventHeader(2, 20), kind: 'hit', action: 2 }], [], 1));
  assert.deepEqual(f.accepted, [1, 2]);
  assert.equal(f.lifecycle.session!.prediction.pending.length, 0);
  assert.equal(f.lifecycle.session!.prediction.seq, inputSequence);
  assert.equal(f.lifecycle.failure, '');
  f.lifecycle.dispose();
});

void test('failed installation never confirms its generation and forged delivery gaps close the session', () => {
  const failed = fixture(1);
  failed.emit(welcome);
  assert.equal(failed.log.includes('send-receipt'), false);
  assert.ok(failed.log.includes('close'));
  assert.equal(
    failed.log.includes('remote-close'),
    false,
    'local failure must not navigate away as a remote administrative close',
  );
  const f = fixture();
  f.emit(welcome);
  f.emitFrame(
    {
      type: 'delivery',
      version: welcome.version,
      connection: 'test',
      sequence: 3,
      generation: 1,
      eventThrough: 0,
      sentAtMs: 100,
      kind: 'state',
      body: snap(4),
    },
    100,
    { now: 100, upper: 100 },
  );
  assert.match(f.lifecycle.failure, /sequence/);
  f.lifecycle.dispose();
  failed.lifecycle.dispose();
});

void test('stable source latency does not trigger repeated recovery, but an arrival pause does', () => {
  const f = fixture();
  f.emit(welcome);
  const state = (sequence: number, now: number) =>
    f.emitFrame(
      {
        type: 'delivery',
        version: welcome.version,
        connection: 'test',
        sequence,
        generation: 1,
        eventThrough: 0,
        sentAtMs: now + 400,
        kind: 'state',
        body: { ...snap(sequence * 4), capturedAtMs: now + 400 },
      },
      now,
      { now: now + 1000, upper: now + 1020 },
    );
  for (let sequence = 2; sequence < 60; sequence++) state(sequence, 100 + (sequence - 1) * 34);
  assert.equal(f.log.includes('send-resync'), false);
  state(60, 3100);
  assert.equal(f.log.filter((entry) => entry === 'send-resync').length, 1);
  assert.equal(f.lifecycle.ready, false);
  state(61, 3134);
  assert.equal(
    f.lifecycle.ready,
    false,
    'ordinary state cannot reopen commands before installation',
  );
  assert.equal(f.lifecycle.failure, '');
  f.lifecycle.dispose();
});

void test('slow initial scene construction does not request an unnecessary recovery', () => {
  const f = fixture();
  f.emit(welcome);
  f.emitFrame(
    {
      type: 'delivery',
      version: welcome.version,
      connection: 'test',
      sequence: 2,
      generation: 1,
      eventThrough: 0,
      sentAtMs: 2000,
      kind: 'state',
      body: snap(4),
    },
    2000,
    { now: 2000, upper: 2000 },
  );
  assert.equal(f.log.includes('send-resync'), false);
  assert.equal(f.lifecycle.ready, true);
  f.lifecycle.dispose();
});

void test('diagnostic history survives resync and map installation with explicit boundaries', () => {
  const f = fixture();
  f.lifecycle.diagnostics.setEnabled(true, 0);
  f.emit(welcome);
  const moved = snap(4);
  moved.players[0]!.state.x += 0.4;
  moved.local!.state.x += 0.4;
  f.emit(moved);
  f.emit({ ...welcome, type: 'resync', tick: 4 });
  f.emit(snap(8));
  f.emit({ ...welcome, type: 'map', round: 2, tick: 12 });
  assert.equal(f.lifecycle.failure, '');
  const report = f.lifecycle.diagnostics.snapshot(100);
  const episode = report.corrections.episodes[0]!;
  assert.ok(episode.maxCorrection > 0.39);
  assert.equal(episode.interrupted, 'installation');
  assert.ok(episode.samples.every((s) => s.generation === 1));
  assert.ok(report.corrections.recent.every((s) => s.generation === 3));
  const samples = report.samples;
  const states = samples.filter((sample) => sample.kind === 'snapshot');
  assert.equal(states.length, 5);
  assert.ok(Math.abs(Number(states[1]!.data.correction) - 0.4) < 1e-10);
  assert.deepEqual(
    states.map((sample) => sample.data.generation),
    [1, 1, 2, 2, 3],
  );
  assert.deepEqual(
    states.map((sample) => sample.data.intervalMs),
    [null, 0, null, 0, null],
  );
  assert.deepEqual(
    states.map((sample) => sample.data.correction),
    [null, states[1]!.data.correction, null, 0, null],
  );
  assert.deepEqual(
    samples.filter((sample) => sample.kind === 'installation').map((sample) => sample.data.type),
    ['welcome', 'resync', 'map'],
  );
});
