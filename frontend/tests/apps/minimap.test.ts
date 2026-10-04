import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineSession } from '../../src/apps/match/session';
import { OnlineView } from '../../src/apps/match/view';
import { own, remote, snap, welcome, batch, eventHeader } from '../support/online';
import type { GameCue, RemotePlayer } from '../../src/contracts/session';

function fixture(mode: 'dm' | 'tdm' | 'ctf' = 'dm') {
  const local = own();
  local.team = 'blue';
  const state = snap(120, local);
  state.match.rules.mode = mode;
  if (mode === 'ctf')
    state.flags = [
      { team: 'blue', state: 'home', carrierId: 0, position: { x: 1, y: 1 } },
      { team: 'red', state: 'home', carrierId: 0, position: { x: 19, y: 19 } },
    ];
  state.players.push(remote({ ...own(), id: 2, team: 'red' }));
  const session = new OnlineSession(welcome);
  session.receive(state, 1000, 1000);
  const view = new OnlineView();
  const actor = (now: number) =>
    view.compose(session, { x: 10, y: 4 }, now, 0, true, 0, 0).actors[0]!;
  const shoot = (id = 1, now = 1000, kind = 'smg', life = 1, round = 1) => {
    const cue: GameCue = {
      ...eventHeader(id, 120),
      ownerId: 2,
      life,
      round,
      occurredAtMs: now,
      kind: 'shot',
      shot: { kind, from: { x: 4, y: 4, z: 0.3 }, to: { x: 8, y: 4, z: 0.3 }, killed: false },
    };
    session.receiveEvents(batch(120, [], [cue]), now, now);
  };
  return { session, state, actor, shoot };
}

void test('DM hides silent players only on minimap; shots fade for two seconds and duplicates do not renew', () => {
  const { session, actor, shoot } = fixture();
  assert.equal(actor(1000).visible, true);
  assert.equal(actor(1000).minimapOpacity, 0);
  shoot();
  assert.equal(actor(1000).minimapOpacity, 1);
  assert.equal(actor(2000).minimapOpacity, 0.5);
  shoot(1, 2000);
  assert.equal(actor(2000).minimapOpacity, 0.5);
  shoot(2, 2000);
  assert.equal(actor(2000).minimapOpacity, 1);
  assert.equal(actor(4000).minimapOpacity, 0);
  assert.equal(
    new OnlineSession(welcome).minimapReveals.opacity(
      session.latest!.players[1]!,
      session.prediction.own,
      session.latest!,
      2000,
    ),
    0,
  );
});

void test('team allies and spectator targets stay visible; DM team labels do not reveal opponents', () => {
  for (const mode of ['dm', 'tdm', 'ctf'] as const) {
    const { session, state } = fixture(mode);
    const enemy = state.players[1]!;
    const ally = { ...enemy, team: 'blue' as const };
    const opacity = (player: RemotePlayer = ally, local = session.prediction.own!) =>
      session.minimapReveals.opacity(player, local, state, 1000);
    assert.equal(opacity(), mode === 'dm' ? 0 : 1);
    assert.equal(opacity(enemy), 0);
    assert.equal(opacity(enemy, { ...own(), status: 'spectator' }), 1);
    assert.equal(opacity({ ...ally, status: 'dead' }), 0);
  }
});

void test('old lives, old rounds, minibot fire and expired cues do not reveal; delayed shots retain their actual age', () => {
  const { session, state, actor, shoot } = fixture();
  shoot(1, 1000, 'smg', 0);
  shoot(2, 1000, 'smg', 1, 0);
  shoot(3, 1000, 'minibot');
  assert.equal(actor(1000).minimapOpacity, 0);
  const cue: GameCue = { ...eventHeader(4, 120), ownerId: 2, kind: 'knives', radius: 1 };
  session.receiveEvents(batch(120, [], [cue]), 2000, 2000);
  assert.equal(actor(2000).minimapOpacity, 0.5);
  session.receiveEvents(batch(120, [], [{ ...cue, id: 5 }]), 3000, 3000);
  assert.equal(actor(3000).minimapOpacity, 0);
  shoot(6, 3000);
  const next = structuredClone(state);
  next.tick++;
  next.players[1]!.life++;
  session.receive(next, 3010, 3010);
  assert.equal(
    session.minimapReveals.opacity(next.players[1]!, session.prediction.own, next, 3010),
    0,
  );
  shoot(7, 3020, 'smg', 2);
  next.tick++;
  next.match.round++;
  session.receive(next, 3030, 3030);
  assert.equal(
    session.minimapReveals.opacity(next.players[1]!, session.prediction.own, next, 3030),
    0,
  );
});

void test('projectile launches reveal once at birth, never from lingering flames or a previous life', () => {
  for (const kind of ['rocket', 'grenade', 'molotov', 'minibot', 'flame'] as const) {
    const { session, state, actor } = fixture();
    const next = structuredClone(state);
    next.tick = 121;
    next.projectiles = [
      {
        id: 1,
        kind,
        ownerId: 2,
        bornTick: 120,
        attachedId: 0,
        expiresTick: 1200,
        motion: 'fixed',
        motionTick: 120,
        position: { x: 4, y: 4, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
      },
    ];
    next.capturedAtMs = 1000 + 1000 / 120;
    session.receive(next, next.capturedAtMs, next.capturedAtMs);
    assert.ok(
      Math.abs(actor(next.capturedAtMs).minimapOpacity! - (kind === 'flame' ? 0 : 1 - 1 / 240)) <
        1e-9,
    );
    next.tick = 360;
    next.capturedAtMs = 3000;
    session.receive(next, 3000, 3000);
    assert.equal(actor(3000).minimapOpacity, 0);
    next.tick++;
    next.players[1]!.life++;
    next.players[1]!.bornTick = 361;
    session.receive(next, 3010, 3010);
    assert.equal(actor(3010).minimapOpacity, 0);
  }
});

void test('throws reveal from their event, death preserves the fade, and departure clears it', () => {
  const { session, state } = fixture();
  const next = structuredClone(state);
  next.tick++;
  next.eventCut = 1;
  session.receive(next, 1010, 1010);
  session.receiveEvents(
    batch(121, [
      { ...eventHeader(1, 121), ownerId: 2, kind: 'signal', signal: 'throw', occurredAtMs: 1010 },
    ]),
    1010,
    1010,
  );
  const enemy = next.players[1]!;
  assert.equal(session.minimapReveals.opacity(enemy, session.prediction.own, next, 1010), 1);
  enemy.status = 'dead';
  assert.equal(session.minimapReveals.opacity(enemy, session.prediction.own, next, 2010), 0.5);
  next.tick++;
  next.players = next.players.slice(0, 1);
  session.receive(next, 2020, 2020);
  assert.equal(session.minimapReveals.opacity(enemy, session.prediction.own, next, 2020), 0);
});

void test('minimap uses original team colors independently of skins and arena markers', () => {
  for (const mode of ['tdm', 'ctf'] as const) {
    for (const team of ['blue', 'red'] as const) {
      const { session, state, shoot } = fixture(mode);
      const next = structuredClone(state);
      next.tick++;
      next.players[0]!.team = team;
      next.players[1]!.team = team;
      session.receive(next, 1000, 1000);
      const view = new OnlineView();
      const compose = (now: number) => view.compose(session, { x: 10, y: 4 }, now, 0, true, 0, 0);
      const enemy = {
        ...next.players[1]!,
        team: team === 'blue' ? ('red' as const) : ('blue' as const),
      };
      assert.equal(compose(1200).player.minimapColor, team === 'blue' ? '#00ffff' : '#ffff00');
      assert.equal(
        compose(1200).actors[0]!.minimapColor,
        team === 'blue' ? 'rgb(0, 0, 255)' : 'rgb(255, 0, 0)',
      );
      assert.equal(
        session.minimapReveals.color(enemy, session.prediction.own, next, 1200),
        team === 'blue' ? '#ff0000' : '#4d4dff',
      );
      shoot(1, 1200);
      assert.equal(
        compose(1200).actors[0]!.minimapColor,
        team === 'blue' ? 'rgb(179, 179, 255)' : 'rgb(255, 179, 179)',
      );
      assert.equal(
        compose(2200).actors[0]!.minimapColor,
        team === 'blue' ? 'rgb(89, 89, 255)' : 'rgb(255, 89, 89)',
      );
      assert.equal(
        compose(3200).actors[0]!.minimapColor,
        team === 'blue' ? 'rgb(0, 0, 255)' : 'rgb(255, 0, 0)',
      );
      assert.equal(compose(2200).actors[0]!.minimapOpacity, 1);
      if (mode === 'ctf') assert.equal(compose(2200).actors[0]!.marker, undefined);
    }
  }
});

void test('neutral DM players use cyan for self and red for opponents regardless of cosmetics', () => {
  const { session, state } = fixture();
  const next = structuredClone(state);
  next.tick++;
  for (const player of next.players) player.team = 'none';
  session.receive(next, 1000, 1000);
  const view = new OnlineView().compose(session, { x: 10, y: 4 }, 1200, 0, true, 0, 0);
  assert.equal(view.player.minimapColor, '#00ffff');
  assert.equal(view.actors[0]!.minimapColor, '#ff0000');
});
