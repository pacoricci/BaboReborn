import { createMatchScreen } from '../../../frontend/src/apps/match/screen';
import { mountMatchScreen } from '../../../frontend/src/apps/match/screen-view';
import { defaultSettings } from '../../../frontend/src/player/player-preferences';
import { snap } from '../../../frontend/tests/support/online';

const screen = createMatchScreen(defaultSettings, '/');
const snapshot = snap(0);
const noop = () => {};
mountMatchScreen(document.getElementById('screen')!, screen, {
  help: noop,
  diagnostics: noop,
  join: noop,
  arena: noop,
  leave: noop,
  rooms: '/',
  equipment: noop,
  retry: noop,
  select: noop,
  options: noop,
  copy: async () => {},
});
function refresh() {
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
  });
}
document.getElementById('finish')!.onclick = () => {
  snapshot.match.phase = 'intermission';
  snapshot.match.ranking = [{ id: 1, team: 'none', score: 50, kills: 50, deaths: 37 }];
  refresh();
  screen.update({ open: false });
};
document.getElementById('advance')!.onclick = () => {
  // Map installation clears the old results before the new snapshot arrives.
  screen.update({ results: { intermission: false, summary: '', notice: '', rows: [] } });
  snapshot.match.phase = 'playing';
  snapshot.match.round++;
  snapshot.match.ranking = [];
  refresh();
  screen.update({ open: true });
};
refresh();
