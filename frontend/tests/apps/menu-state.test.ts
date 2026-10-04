import test from 'node:test';
import assert from 'node:assert/strict';
import { matchMenuState } from '../../src/apps/match/menu-state';
import { own, snap } from '../support/online';

void test('spectators can explicitly join an active round, but not while a join is pending', () => {
  const player = { ...own(), status: 'spectator' as const };
  const match = snap(0).match;
  const watching = matchMenuState(player, match, 0, 120);
  assert.equal(watching.canJoin, true);
  assert.equal(watching.canRespawn, false);
  assert.equal(watching.returnLabel, 'Watch match');
  const waiting = matchMenuState(player, match, 0, 120, true);
  assert.equal(waiting.canJoin, false);
  assert.equal(waiting.status, 'Joining…');
  // Merely deriving menu/return presentation never changes authority.
  assert.equal(player.status, 'spectator');
});

void test('death eligibility uses the configured tick rate and exact server deadline', () => {
  const player = { ...own(), status: 'dead' as const, diedTick: 100 };
  const match = snap(0).match;
  match.rules.respawnTicks = 180;
  const waiting = matchMenuState(player, match, 220, 60);
  assert.equal(waiting.remaining, 1);
  assert.equal(waiting.canRespawn, false);
  assert.equal(waiting.canJoin, false);
  assert.equal(waiting.returnLabel, 'Back to arena');
  assert.equal(matchMenuState(player, match, 279, 60).canRespawn, false);
  assert.equal(matchMenuState(player, match, 280, 60).canRespawn, true);
  match.rules.forceRespawn = true;
  const forced = matchMenuState(player, match, 280, 60);
  assert.equal(forced.canRespawn, false);
  assert.match(forced.notice, /automatically/);
});

void test('intermission overrides alive, dead, spectator and pending-join permissions', () => {
  const match = snap(0).match;
  match.phase = 'intermission';
  match.endsTick = 1200;
  for (const status of ['spectator', 'alive', 'dead'] as const) {
    for (const pending of [false, true]) {
      const state = matchMenuState({ ...own(), status }, match, 960, 120, pending);
      assert.equal(state.canJoin, false);
      assert.equal(state.canRespawn, false);
      assert.equal(state.status, 'Round complete');
      assert.match(state.notice, /Next match in 2s/);
    }
  }
});

void test('new round preserves spectator intent and exposes participant respawn', () => {
  const match = snap(0).match;
  const spectator = matchMenuState({ ...own(), status: 'spectator' }, match, 1200, 120);
  const participant = matchMenuState({ ...own(), status: 'dead', diedTick: 0 }, match, 1200, 120);
  assert.equal(spectator.canRespawn, false);
  assert.equal(spectator.returnLabel, 'Watch match');
  assert.equal(participant.canRespawn, true);
  const alive = matchMenuState(own(), match, 1200, 120);
  assert.equal(alive.canJoin, false);
  assert.equal(alive.canRespawn, false);
  assert.equal(alive.returnLabel, 'Resume match');
  assert.match(alive.notice, /take damage/);
});

void test('respawn help follows the assigned fire control', () => {
  const state = matchMenuState(
    { ...own(), status: 'dead', diedTick: 0 },
    snap(0).match,
    10000,
    120,
    false,
    'Q',
  );
  assert.match(state.notice, /press Q to spawn/);
});
