import { DEFAULT_APPEARANCE } from '../../src/player/appearance';
import { PROTOCOL } from '../../src/contracts/session';
import type {
  LocalPlayer,
  RemotePlayer,
  Snapshot,
  Welcome,
  EventBatch,
  GameEvent,
  GameCue,
} from '../../src/contracts/session';
import { createPlayer } from '../../src/core/simulation';
import { SMG_MUZZLE } from '../../src/gameconfig/tuning';
export const welcome: Welcome = {
  activities: [],
  type: 'welcome',
  tick: 0,
  eventCut: 0,
  round: 1,
  version: PROTOCOL,
  id: 1,
  tickHz: 120,
  snapshotHz: 30,
  arena: {
    name: 'Synthetic',
    schema: 1,
    theme: 'classic',
    id: 'synthetic',
    author: 'Tests',
    width: 20,
    height: 20,
    walls: [],
    spawns: [{ x: 4, y: 4 }],
  },
  shotGeometry: {
    muzzleOffset: SMG_MUZZLE.forward,
    muzzleSide: SMG_MUZZLE.right,
    muzzleHeight: SMG_MUZZLE.height,
    wallHeight: 0.7,
    maxDistance: 128,
  },
};
export function own(): LocalPlayer {
  return {
    team: 'none',
    nickname: 'Player 1',
    appearance: DEFAULT_APPEARANCE,
    id: 1,
    state: createPlayer({ x: 4, y: 4 }, 0),
    hp: 100,
    status: 'alive',
    life: 1,
    bornTick: 0,
    diedTick: 0,
    ack: 0,
    seed: 7292,
  };
}
export function snap(tick: number, player = own()): Snapshot {
  return {
    match: {
      round: 1,
      phase: 'playing',
      scores: { blue: 0, red: 0 },
      startedTick: 0,
      endsTick: 0,
      rules: {
        mode: 'dm',
        scoreLimit: 50,
        timeLimitTicks: 216000,
        respawnTicks: 120,
        endTicks: 1200,
        forceRespawn: false,
      },
      ranking: [],
    },
    items: [],
    projectiles: [],
    type: 'snapshot',
    flags: [],
    version: PROTOCOL,
    tick,
    capturedAtMs: Math.floor((tick * 1000) / 120),
    players: [remote(player)],
    local: {
      id: player.id,
      state: player.state,
      ack: player.ack,
      seed: player.seed,
      diedTick: player.diedTick,
    },
    eventCut: 0,
  };
}

export const eventHeader = (id: number, tick: number) => ({
  id,
  tick,
  occurredAtMs: Math.floor((tick * 1000) / 120),
  round: 1,
  ownerId: 1,
  life: 1,
  position: { x: 4, y: 4, z: 0.25 },
});
export function batch(
  tick: number,
  events: GameEvent[] = [],
  cues: GameCue[] = [],
  after = 0,
): EventBatch {
  return {
    type: 'events',
    version: PROTOCOL,
    tick,
    after,
    through: Math.max(after, ...events.map((e) => e.id)),
    events,
    cues,
  };
}

export function remote(player: RemotePlayer): RemotePlayer {
  const { x, y, angle, cooldown, equipment: e } = player.state;
  const { primary, secondary, shells, charge, sinceShot, protection, meleeDelay } = e;
  return {
    id: player.id,
    team: player.team,
    nickname: player.nickname,
    appearance: player.appearance,
    hp: player.hp,
    status: player.status,
    life: player.life,
    bornTick: player.bornTick,
    state: {
      x,
      y,
      angle,
      cooldown,
      equipment: { primary, secondary, shells, charge, sinceShot, protection, meleeDelay },
    },
  };
}
