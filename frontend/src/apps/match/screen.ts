import { bindingLabel } from '../../player/game-options';
import { createStore } from 'solid-js/store';
import type { Match, LocalPlayer, RemotePlayer } from '../../contracts/session';
import type { PlayerSettings } from '../../player/player-preferences';
import { matchMenuState } from './menu-state';

interface Standing {
  id: number;
  place: number;
  team: string;
  own: boolean;
  name: string;
  nicknameColors?: string | undefined;
  score: number;
  kills: number;
  deaths: number;
}
interface Results {
  intermission: boolean;
  summary: string;
  winner?: RemotePlayer | undefined;
  notice: string;
  rows: Standing[];
  teams?: { team: string; label: string; score: number; unit: string }[] | undefined;
}
export function presentResults(
  match: Match,
  players: readonly RemotePlayer[],
  ownID: number,
): Results {
  const names = new Map(players.map((player) => [player.id, player.nickname]));
  const own = players.find((player) => player.id === ownID);
  const intermission = match.phase === 'intermission';
  const teamMatch = match.rules.mode !== 'dm';
  const ordered = teamMatch
    ? [...match.ranking].sort((a, b) => a.team.localeCompare(b.team) || b.score - a.score)
    : match.ranking;
  const leaders = match.ranking.filter((row) => row.score === match.ranking[0]?.score);
  const summary = teamMatch
    ? intermission
      ? `${match.scores.blue === match.scores.red ? 'Draw' : match.scores.blue > match.scores.red ? 'Blue team wins' : 'Red team wins'} · ${match.scores.blue} — ${match.scores.red}`
      : `${match.ranking.length} players · Automatic teams · Friendly fire off`
    : !leaders.length
      ? 'No participants yet.'
      : !intermission
        ? `${match.ranking.length} players in the fight`
        : leaders.length > 1
          ? `Tied at ${leaders[0]!.score} points`
          : `${names.get(leaders[0]!.id) ?? `Player ${leaders[0]!.id}`} wins · ${leaders[0]!.score} points`;
  const places = new Map<string, number>();
  return {
    intermission,
    summary,
    winner:
      !teamMatch && intermission && leaders.length === 1
        ? players.find((p) => p.id === leaders[0]!.id)
        : undefined,
    teams: teamMatch
      ? (['blue', 'red'] as const).map((team) => ({
          team,
          label: team === 'blue' ? 'Blue team' : 'Red team',
          score: match.scores[team],
          unit: match.rules.mode === 'ctf' ? 'captures' : 'points',
        }))
      : undefined,
    notice: !intermission
      ? ''
      : own?.status === 'spectator'
        ? 'Next match starts automatically. Choose Play to join.'
        : match.rules.forceRespawn
          ? 'Next match starts automatically. You will respawn when ready.'
          : 'When the next match starts, left-click in the arena to spawn.',
    rows: ordered.map((row, index) => {
      const place = (places.get(row.team) ?? 0) + 1;
      places.set(row.team, place);
      return {
        id: row.id,
        place: teamMatch ? place : index + 1,
        team: row.team,
        own: row.id === ownID,
        name: `${names.get(row.id) ?? `Player ${row.id}`}${row.id === ownID ? ' (you)' : ''}`,
        nicknameColors: players.find((p) => p.id === row.id)?.nicknameColors,
        score: row.score,
        kills: row.kills,
        deaths: row.deaths,
      };
    }),
  };
}
interface MatchScreenState {
  open: boolean;
  help: boolean;
  panel: 'match' | 'options';
  showScores: boolean;
  room: string;
  arena: string;
  connection: string;
  portal: string | null;
  invite: string;
  warning: string;
  title: string;
  notice: string;
  hideNotice: boolean;
  status: string;
  respawnSeconds: number | null;
  autoRespawn: boolean;
  serverInfo: string;
  ready: boolean;
  failed: boolean;
  hasSession: boolean;
  spectator: boolean;
  intermission: boolean;
  joining: boolean;
  canJoin: boolean;
  returnLabel: string;
  selectionStatus: boolean;
  diagnosticsNotice: string;
  preferencesStatus: string;
  settings: PlayerSettings;
  results: Results;
}

/** Page-owned presentation state; the game runtime feeds detached UI values. */
export type MatchScreen = ReturnType<typeof createMatchScreen>;
export function createMatchScreen(settings: PlayerSettings, invite: string) {
  let disposed = false;
  let resultsKey = '';
  const [state, setState] = createStore<MatchScreenState>({
    open: true,
    help: false,
    panel: 'match',
    showScores: false,
    room: 'Checking room…',
    arena: 'Preparing match…',
    connection: 'Connecting…',
    portal: null,
    invite,
    warning: '',
    title: 'Match menu',
    notice: 'Connecting…',
    hideNotice: false,
    status: '',
    respawnSeconds: null,
    autoRespawn: false,
    serverInfo: '',
    ready: false,
    failed: false,
    hasSession: false,
    spectator: true,
    intermission: false,
    joining: false,
    canJoin: false,
    returnLabel: 'Resume match',
    selectionStatus: false,
    diagnosticsNotice: '',
    preferencesStatus: '',
    settings: { ...settings },
    results: { intermission: false, summary: '', notice: '', rows: [] },
  });
  function update(patch: Partial<MatchScreenState>): void {
    if (!disposed) setState(patch);
  }
  function scores(visible: boolean): void {
    if (visible !== state.showScores) update({ showScores: visible });
  }
  function refresh(value: {
    own: LocalPlayer | null | undefined;
    match: Match | undefined;
    players: readonly RemotePlayer[] | undefined;
    tick: number;
    tickHz: number;
    ready: boolean;
    failure: string;
    hasSession: boolean;
    joining: boolean;
    joinProblem: string;
  }): void {
    const menu =
      value.ready && value.own && value.match
        ? matchMenuState(
            value.own,
            value.match,
            value.tick,
            value.tickHz,
            value.joining,
            bindingLabel(state.settings.bindings.fire),
          )
        : null;
    const ready = !!menu && !value.failure;
    update({
      ready,
      respawnSeconds:
        ready && value.own?.status === 'dead' && !menu.intermission
          ? Math.ceil(menu.remaining)
          : null,
      autoRespawn: value.match?.rules.forceRespawn ?? false,
      failed: !!value.failure,
      hasSession: value.hasSession,
      joining: value.joining,
      canJoin: ready && menu.canJoin,
      spectator: menu?.spectator ?? true,
      intermission: menu?.intermission ?? false,
      selectionStatus: !!value.own && value.own.status !== 'spectator',
      ...(ready
        ? {
            title: menu.title,
            notice: value.joinProblem || menu.notice,
            hideNotice:
              menu.spectator && !menu.intermission && !value.joining && !value.joinProblem,
            status: menu.status,
            returnLabel: menu.returnLabel,
            serverInfo: ` · ${value.players?.filter((player) => player.status !== 'spectator').length ?? 0} playing`,
          }
        : { hideNotice: false }),
    });
    if (value.match && value.players) {
      // Only snapshots project standings. Render frames only change score visibility.
      const key = JSON.stringify([
        value.match.ranking,
        value.players.map((p) => [p.id, p.nickname, p.nicknameColors]),
        value.match.phase,
        value.match.scores,
        value.match.rules.mode,
        value.match.rules.forceRespawn,
        value.own?.id,
        value.own?.status,
      ]);
      if (key !== resultsKey) {
        resultsKey = key;
        update({ results: presentResults(value.match, value.players, value.own?.id ?? 0) });
      }
    }
  }
  function dispose(): void {
    disposed = true;
  }
  return { state, update, scores, refresh, dispose };
}
