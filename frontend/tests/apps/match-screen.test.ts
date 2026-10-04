import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatchScreen, presentResults } from '../../src/apps/match/screen';
import { defaultSettings } from '../../src/player/player-preferences';
import { own, snap } from '../support/online';

function fixture() {
  const player = { ...own(), status: 'spectator' as const };
  const snapshot = snap(0, player);
  const screen = createMatchScreen(defaultSettings, '/rooms/test-reference');
  const refresh = (patch = {}) =>
    screen.refresh({
      own: { ...snapshot.players[0]!, ...snapshot.local! },
      match: snapshot.match,
      players: snapshot.players,
      tick: snapshot.tick,
      tickHz: 120,
      ready: true,
      failure: '',
      hasSession: true,
      joining: false,
      joinProblem: '',
      ...patch,
    });
  return { screen, snapshot, refresh };
}
void test('loading, joining, failure and intermission cannot expose an actionable join', () => {
  const { screen, snapshot, refresh } = fixture();
  assert.equal(screen.state.canJoin, false);
  refresh();
  assert.equal(screen.state.canJoin, true);
  refresh({ joining: true });
  assert.equal(screen.state.canJoin, false);
  assert.equal(screen.state.notice, 'Joining…');
  refresh({ failure: 'Connection lost' });
  assert.equal(screen.state.canJoin, false);
  assert.equal(screen.state.ready, false);
  snapshot.match.phase = 'intermission';
  refresh();
  assert.equal(screen.state.canJoin, false);
  assert.equal(screen.state.intermission, true);
  assert.equal(snapshot.players[0]!.status, 'spectator');
});
void test('menu visibility, settings and score hold do not mutate authority or rebuild standings', () => {
  const { screen, snapshot, refresh } = fixture();
  refresh();
  const rows = screen.state.results;
  screen.update({ open: false, showScores: true, panel: 'options' });
  snapshot.tick++;
  refresh();
  assert.equal(screen.state.results, rows);
  assert.equal(screen.state.open, false);
  assert.equal(screen.state.showScores, true);
  assert.equal(snapshot.players[0]!.status, 'spectator');
  snapshot.players[0]!.nickname = 'Renamed';
  refresh();
  assert.notEqual(screen.state.results, rows);
});
void test('individual and team results preserve ordering, ties, self labels and respawn instructions', () => {
  const player = own();
  const other = { ...own(), id: 2, nickname: '<script>Not markup</script>' };
  const match = snap(0).match;
  match.phase = 'intermission';
  match.ranking = [
    { id: 2, team: 'red', score: 3, kills: 3, deaths: 1 },
    { id: 1, team: 'blue', score: 3, kills: 3, deaths: 1 },
  ];
  const original = structuredClone(match.ranking);
  const individual = presentResults(match, [player, other], 1);
  assert.equal(individual.summary, 'Tied at 3 points');
  assert.equal(individual.rows[0]!.name, other.nickname);
  assert.match(individual.rows[1]!.name, /\(you\)/);
  assert.match(individual.notice, /left-click/);
  match.rules.mode = 'ctf';
  match.scores = { blue: 7, red: 2 };
  const teams = presentResults(match, [player, other], 1);
  assert.equal(teams.summary, 'Blue team wins · 7 — 2');
  assert.equal(teams.rows[0]!.team, 'blue');
  assert.deepEqual(teams.teams, [
    { team: 'blue', label: 'Blue team', score: 7, unit: 'captures' },
    { team: 'red', label: 'Red team', score: 2, unit: 'captures' },
  ]);
  assert.deepEqual(
    teams.rows.map((row) => row.place),
    [1, 1],
  );
  assert.equal(teams.rows[1]!.name, other.nickname);
  assert.equal(individual.teams, undefined);
  match.rules.mode = 'tdm';
  assert.equal(presentResults(match, [player, other], 1).teams?.[0]?.unit, 'points');
  match.rules.mode = 'ctf';
  assert.deepEqual(match.ranking, original);
  match.rules.forceRespawn = true;
  assert.match(presentResults(match, [player, other], 1).notice, /automatically/);
});
void test('disposed screen ignores late lifecycle callbacks', () => {
  const { screen, refresh } = fixture();
  refresh();
  screen.dispose();
  screen.update({ warning: 'late operation' });
  refresh({ failure: 'late close' });
  assert.equal(screen.state.warning, '');
  assert.equal(screen.state.failed, false);
});

void test('respawn countdown follows authority and clears outside an active dead life', () => {
  const { screen, snapshot, refresh } = fixture();
  const player = snapshot.players[0]!;
  player.status = 'dead';
  snapshot.local!.diedTick = 100;
  snapshot.match.rules.respawnTicks = 180;
  refresh({ tick: 101, tickHz: 60 });
  assert.equal(screen.state.respawnSeconds, 3);
  refresh({ tick: 279, tickHz: 60 });
  assert.equal(screen.state.respawnSeconds, 1);
  refresh({ tick: 280, tickHz: 60 });
  assert.equal(screen.state.respawnSeconds, 0);
  snapshot.match.rules.forceRespawn = true;
  refresh({ tick: 281, tickHz: 60 });
  assert.equal(screen.state.autoRespawn, true);
  assert.equal(screen.state.respawnSeconds, 0);
  refresh({ ready: false });
  assert.equal(screen.state.respawnSeconds, null);
  refresh({ failure: 'Disconnected' });
  assert.equal(screen.state.respawnSeconds, null);
  snapshot.match.phase = 'intermission';
  refresh();
  assert.equal(screen.state.respawnSeconds, null);
  snapshot.match.phase = 'playing';
  for (const status of ['alive', 'spectator'] as const) {
    player.status = status;
    refresh();
    assert.equal(screen.state.respawnSeconds, null);
  }
});
