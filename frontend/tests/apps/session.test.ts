import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineSession } from '../../src/apps/match/session';
import { OnlineView } from '../../src/apps/match/view';
import type { StateUpdate } from '../../src/contracts/session';
import { HeldAction } from '../../src/apps/match/held-action';
import { own, snap, welcome, batch, eventHeader } from '../support/online';
const input = () => ({ x: 1, y: 0, aim: { x: 10, y: 4 }, fire: false, secondary: false });

void test('pickup reuse preserves exact positions and independent grenades until explicit removal', () => {
  const session = new OnlineSession(welcome);
  const initial = snap(1);
  initial.items = [
    {
      motion: 'fixed',
      motionTick: 0,
      velocity: { x: 0, y: 0, z: 0 },
      expiresTick: 1000,
      id: 1,
      kind: 'grenade',
      position: { x: 4.123456789, y: 4, z: 1 },
    },
    {
      motion: 'fixed',
      motionTick: 0,
      velocity: { x: 0, y: 0, z: 0 },
      expiresTick: 1000,
      id: 2,
      kind: 'grenade',
      position: { x: 4.4, y: 4, z: 0.7 },
    },
    {
      motion: 'fixed',
      motionTick: 0,
      velocity: { x: 0, y: 0, z: 0 },
      expiresTick: 1000,
      id: 3,
      kind: 'weapon',
      primary: 'smg',
      position: { x: 5, y: 4, z: 0.15 },
    },
  ];
  session.receive(initial, 10, 10);
  const update: StateUpdate = snap(2);
  delete update.items;
  session.receive(update, 20, 20);
  assert.deepEqual(session.latest!.items, initial.items);
  assert.equal(update.items, undefined, 'materialization must not modify the wire message');
  const moving = structuredClone(initial.items);
  moving[0]!.position.z = 0.234567891;
  moving[0]!.motionTick = 3;
  session.receive({ ...snap(3), items: moving }, 30, 30);
  assert.equal(initial.items[0]!.position.z, 1, 'previous snapshot must stay immutable');
  const view = new OnlineView().compose(session, { x: 10, y: 4 }, 30, 0, true, 0, 0);
  assert.equal(
    view.objects!.find((entity) => entity.id === 1)!.z,
    1,
    'pickup shares the delayed playback cursor',
  );
  const advanced = new OnlineView().compose(session, { x: 10, y: 4 }, 140, 0, true, 0, 0);
  for (const item of moving) {
    const rendered = advanced.objects!.find((entity) => entity.id === item.id)!;
    assert.deepEqual({ x: rendered.x, y: rendered.y, z: rendered.z }, item.position);
  }
  session.receive({ ...snap(4), items: moving.slice(1) }, 40, 40);
  assert.deepEqual(
    session.latest!.items.map((item) => item.id),
    [2, 3],
  );
  session.receive({ ...snap(5), items: [] }, 50, 50);
  session.receive({ ...update, tick: 6 }, 60, 60);
  assert.deepEqual(session.latest!.items, []);

  const recovered = new OnlineSession({ ...welcome, type: 'resync' });
  assert.throws(() => recovered.receive(update, 20, 20), /installed entity list/);
  recovered.receive({ ...snap(7), items: moving }, 70, 70);
  recovered.receive({ ...update, tick: 8 }, 80, 80);
  assert.deepEqual(recovered.latest!.items, moving);
  assert.throws(
    () => recovered.receive({ ...update, tick: 9, match: { ...update.match, round: 2 } }, 90, 90),
    /installed entity list/,
  );
});

void test('fire retains the last rendered scene across arrivals, batching and replay', () => {
  const session = new OnlineSession(welcome);
  session.receive(snap(501), 0, 0);
  session.receive(snap(505), 34, 34);
  session.receive(snap(513), 100, 100);
  session.rendered(116.66666666666667);
  const shown = session.interpolation.view(116.66666666666667, 120)!;
  assert.equal(shown.from, 501);
  assert.equal(shown.to, 505);
  assert.ok(Math.abs(shown.alpha - 0.5) < 1e-10);
  session.receive(snap(517), 134, 134);
  session.advance({ ...input(), fire: true }, 1 / 60, 135, true, () => {});
  const commands = session.batch(135)!;
  assert.equal(commands.length, 2);
  assert.deepEqual(
    commands.map((c) => c.view),
    [shown, shown],
  );
  assert.notEqual(commands[0]!.view, commands[1]!.view);
  session.receive(snap(521), 167, 167);
  assert.deepEqual(
    session.prediction.pending.map((c) => c.view),
    [shown, shown],
  );
  session.rendered(167);
  assert.deepEqual(commands[0]!.view, shown, 'later rendering cannot retime queued shots');
  session.release();
  session.advance({ ...input(), fire: true }, 1 / 120, 176, true, () => {});
  assert.equal(session.prediction.pending[0]!.view, undefined);
});

void test('movement inputs do not carry shot history', () => {
  const session = new OnlineSession(welcome);
  session.receive(snap(1), 0, 0);
  session.rendered(0);
  session.advance(input(), 1 / 120, 9, true, () => {});
  assert.equal(session.prediction.pending[0]!.view, undefined);
});

for (const mode of ['ctf', 'tdm'] as const) {
  void test(`${mode} colors local and remote skins without rings and restores cosmetics in DM`, () => {
    const session = new OnlineSession(welcome);
    const adapter = new OnlineView();
    const state = snap(1, { ...own(), team: 'red' });
    state.players.push({
      ...own(),
      id: 2,
      team: 'blue',
      appearance: { template: 'bands', colors: ['#ffffff', '#000000', '#00ff00'] },
    });
    const originals = structuredClone(state.players.map((p) => p.appearance));
    state.match.rules.mode = mode;
    state.flags =
      mode === 'ctf'
        ? [
            { team: 'blue', state: 'home', carrierId: 0, position: { x: 1, y: 1 } },
            { team: 'red', state: 'home', carrierId: 0, position: { x: 19, y: 19 } },
          ]
        : [];
    session.receive(state, 0, state.capturedAtMs);
    const teamView = adapter.compose(session, { x: 10, y: 4 }, 0, 0, true, 0, 0);
    assert.deepEqual(teamView.player.appearance, {
      template: originals[0]!.template,
      colors: ['#db4545', '#c73535', '#e85959'],
    });
    assert.deepEqual(teamView.actors[0]!.appearance, {
      template: 'bands',
      colors: ['#367cdb', '#2869c4', '#4a8de8'],
    });
    assert.equal(teamView.player.marker, undefined);
    assert.equal(teamView.actors[0]!.marker, undefined);
    assert.deepEqual(
      state.players.map((p) => p.appearance),
      originals,
    );

    const next = structuredClone(state);
    next.tick++;
    next.match.rules.mode = 'dm';
    for (const player of next.players) player.team = 'none';
    next.flags = [];
    session.receive(next, 100, next.capturedAtMs);
    const dm = adapter.compose(session, { x: 10, y: 4 }, 100, 0, true, 0, 0);
    assert.deepEqual(dm.player.appearance, originals[0]);
    assert.deepEqual(dm.actors[0]!.appearance, originals[1]);
    assert.equal(dm.player.marker, undefined);
    assert.equal(dm.actors[0]!.marker, undefined);
  });
}

void test('session schedules equal fixed steps across frames and batches without waiting for authority', () => {
  const a = new OnlineSession(welcome),
    b = new OnlineSession(welcome);
  a.receive(snap(1), 0, 8);
  b.receive(snap(1), 0, 8);
  const command = input();
  a.advance(command, 1 / 30, 34, true, () => {});
  for (let i = 1; i <= 4; i++) b.advance(command, 1 / 120, i * 8.34, true, () => {});
  assert.deepEqual(a.prediction.player, b.prediction.player);
  assert.deepEqual(a.prediction.pending, b.prediction.pending);
  assert.equal(a.prediction.pending.length, 4);
  assert.ok(a.prediction.player!.x > 4);
  assert.equal(a.batch(10), null);
  assert.equal(a.batch(34)?.length, 4);
  assert.equal(a.batch(70), null);
  assert.equal(a.prediction.pending.length, 4);
});
void test('session consumes a short secondary tap once even across multiple ticks in one frame', () => {
  const session = new OnlineSession(welcome),
    tap = new HeldAction(),
    command = input();
  session.receive(snap(1), 0, 8);
  tap.press();
  tap.release();
  command.secondary = tap.active;
  session.advance(command, 1 / 30, 34, true, () => {
    tap.consume();
    command.secondary = tap.active;
  });
  assert.deepEqual(
    session.batch(34)?.map((c) => c.secondary),
    [true, false, false, false],
  );
});
void test('release, death, life and intermission discard outgoing commands and fractional time', () => {
  const session = new OnlineSession(welcome);
  session.receive(snap(1), 0, 8);
  session.advance(input(), 1 / 80, 13, true, () => {});
  session.release();
  assert.equal(session.batch(20), null);
  assert.equal(session.prediction.pending.length, 0);
  session.advance(input(), 1 / 240, 25, true, () => {});
  assert.equal(session.prediction.pending.length, 0, 'release must clear the half tick');
  session.advance(input(), 1 / 60, 42, true, () => {});
  const dead = own();
  dead.status = 'dead';
  dead.hp = 0;
  const death = session.receive(snap(2, dead), 44, 16)!;
  assert.equal(death.statusChanged, true);
  assert.equal(session.batch(50), null);
  const next = own();
  next.life = 2;
  assert.equal(session.receive(snap(3, next), 60, 25)!.lifeChanged, true);
  session.advance(input(), 1 / 60, 77, true, () => {});
  const end = snap(4, next);
  end.match.phase = 'intermission';
  assert.equal(session.receive(end, 80, end.capturedAtMs)!.phaseChanged, true);
  assert.equal(session.batch(100), null);
  session.advance(input(), 1, 100, true, () => {});
  assert.equal(session.prediction.pending.length, 0);
});
void test('state replacement does not consume required events or infer damage from HP', () => {
  const session = new OnlineSession(welcome);
  session.receive(snap(1), 0, 8);
  const newest = snap(40);
  newest.eventCut = 2;
  session.receive(newest, 333, newest.capturedAtMs);
  const events = batch(20, [
    { ...eventHeader(1, 10), kind: 'damage', amount: 30, weapon: 'smg' },
    { ...eventHeader(2, 20), kind: 'signal', signal: 'pickup-health' },
  ]);
  const result = session.receiveEvents(events, 333, 333);
  assert.equal(result.accepted.length, 2);
  assert.equal(session.latest!.players[0]!.hp, 100);
  assert.equal(session.eventThrough, 2);
  assert.equal(session.receivedAt, 333);
  assert.equal(session.receiveEvents(events, 334, 334).accepted.length, 0);
  assert.throws(
    () => session.receiveEvents({ ...events, after: 3, through: 4 }, 340, 340),
    /history/,
  );
});
void test('stale authority never refreshes receive time and stalled prediction remains bounded', () => {
  const session = new OnlineSession(welcome),
    first = snap(10);
  session.receive(first, 0, first.capturedAtMs);
  assert.equal(session.receive(first, 300, first.capturedAtMs + 300), null);
  assert.equal(session.receivedAt, 0);
  session.advance(input(), 1 / 60, 501, true, () => {});
  assert.equal(session.prediction.pending.length, 0);
  const resumedAt = first.capturedAtMs + 510;
  session.receive({ ...first, tick: 11, capturedAtMs: resumedAt }, 510, resumedAt);
  session.advance(input(), 10, 511, true, () => {});
  assert.equal(session.prediction.pending.length, 12);
});

void test('online view isolates mutable mechanics and uses the last alive camera for death', () => {
  const session = new OnlineSession(welcome),
    adapter = new OnlineView();
  session.receive(snap(1), 0, 8);
  const before = structuredClone(session.prediction.player);
  const alive = adapter.compose(session, { x: 10, y: 4 }, 0, 0, true, 0, 0);
  assert.equal('equipment' in alive.player, false);
  assert.deepEqual(session.prediction.player, before);
  const dead = own();
  dead.status = 'dead';
  dead.hp = 0;
  session.receive(snap(2, dead), 20, 16);
  const view = adapter.compose(session, { x: 19, y: 19 }, 20, 0, true, 0, 0);
  assert.equal(view.player.visible, false);
  assert.equal(view.camera!.target.x, (4 * 5 + 10 * 4) / 9);
  assert.equal(view.camera!.target.y, 4);
  assert.equal(view.camera!.height, 7);
});

void test('presentation uses equipment state and authority-owned device timing without mutation', () => {
  const session = new OnlineSession(welcome),
    view = new OnlineView(),
    state = snap(120);
  state.players[0]!.state.equipment.primary = 'photon';
  state.local!.state.equipment.primary = 'photon';
  state.players[0]!.state.equipment.charge = 0.25;
  state.local!.state.equipment.charge = 0.25;
  state.projectiles = [
    {
      id: 2,
      kind: 'minibot',
      ownerId: 1,
      bornTick: 100,
      expiresTick: 600,
      motion: 'fixed' as const,
      motionTick: 0,
      attachedId: 0,
      position: { x: 5, y: 4, z: 0.1 },
      velocity: { x: 0, y: 0, z: 0 },
      turret: { angle: 1.2, lastShotTick: 116 },
    },
  ];
  for (const [id, kind, speed] of [
    [3, 'grenade', 3],
    [4, 'molotov', 4],
    [5, 'grenade', 0],
  ] as const)
    state.projectiles.push({
      id,
      kind,
      ownerId: 1,
      bornTick: 60,
      expiresTick: 480,
      motion: 'fixed' as const,
      motionTick: 0,
      attachedId: 0,
      position: { x: 6, y: 4, z: speed ? 0.5 : 0.01 },
      velocity: { x: speed, y: 0, z: 0 },
    });
  session.receive(state, 1000, state.capturedAtMs);
  const before = structuredClone(state);
  const output = view.compose(session, { x: 10, y: 4 }, 1050, 0.05, true, 0, 0);
  assert.equal(output.player.weapon!.charge, 0.5);
  for (const id of [3, 4, 5])
    assert.deepEqual(output.objects!.find((object) => object.id === id)!.throwMotion, {
      age: 0.55,
      moving: id !== 5,
    });
  assert.equal(output.objects![0]!.throwMotion, undefined);

  assert.equal(output.objects![0]!.turret!.angle, 1.2);
  assert.ok(Math.abs(output.objects![0]!.turret!.shotAge - 10 / 120) < 1e-9);
  const stale = view.compose(session, { x: 10, y: 4 }, 5000, 0.05, true, 0, 0);
  assert.ok(Math.abs(stale.objects![0]!.turret!.shotAge - 16 / 120) < 1e-9);
  assert.deepEqual(state, before);
});

void test('attached fire follows rendered carriers instead of delayed projectile positions', () => {
  const session = new OnlineSession(welcome);
  const state = snap(120);
  const remote = own();
  remote.id = 2;
  remote.state.x = 9;
  state.players.push(remote);
  state.projectiles = [1, 2, 0, 99].map((attached, index) => ({
    id: 100 + index,
    kind: 'flame',
    motion: 'fixed' as const,
    motionTick: 0,
    attachedId: attached,
    ownerId: 1,
    bornTick: 100,
    expiresTick: 480,
    position: { x: 3, y: 3, z: 0.25 },
    velocity: { x: 0, y: 0, z: 0 },
  }));
  session.receive(state, 1000, state.capturedAtMs);
  const before = structuredClone(state);
  const adapter = new OnlineView();
  for (const x of [5, 6, 7]) {
    session.prediction.player!.x = x;
    const view = adapter.compose(session, { x: 10, y: 4 }, 1000, 0, true, 0, 0);
    const flames = view.objects!;
    assert.equal(flames[0]!.x, view.player.x, 'local fire follows prediction immediately');
    assert.equal(flames[0]!.y, view.player.y);
    assert.equal(flames[0]!.z, 0.03, 'fire starts near the feet, not above the body center');
    assert.equal(flames[1]!.x, view.actors[0]!.x, 'remote fire shares the interpolated pose');
    assert.equal(flames[1]!.y, view.actors[0]!.y);
    for (const flame of flames.slice(2))
      assert.deepEqual({ x: flame.x, y: flame.y, z: flame.z }, { x: 3, y: 3, z: 0.25 });
  }
  assert.deepEqual(state, before, 'attachment is presentation-only');
});
