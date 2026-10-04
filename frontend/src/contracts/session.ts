import type { Motion } from '../core/motion';
import type { Activity, Team } from './activity';
import type { Equipment, Primary, Secondary } from '../core/equipment';
// Internal protocol contract. Versioned with the Go authority, not a stable public API.
import type { Input, Player, Shot, ShotGeometry } from '../core/simulation';
import type { ArenaMap } from '../maps/types';
import type { Appearance } from '../player/appearance';
export const PROTOCOL = 1;

// Session closures and notices mirror backend/server/transport; both languages
// are checked against backend/server/transport/testdata/session-contract.json.
export const CLOSE = {
  // The room restarted; the browser rejoins as a spectator.
  roomRestarted: 4001,
  // Invalid messages, identity or server registration.
  rejected: 4002,
  // Staff action, a newer session, idleness or failed delivery.
  removed: 4003,
  roomClosed: 4004,
  // Admission found no free slot.
  roomFull: 1013,
} as const;
// Server reasons the browser explains; others are shown as text.
export const CLOSE_REASON = {
  roomClosed: 'room_closed',
  authenticationExpired: 'authentication_expired',
  sanctionActive: 'sanction_active',
  kicked: 'kicked',
  gameSessionReplaced: 'game_session_replaced',
} as const;
export const ADMINISTRATION_ACTIONS = [
  'restart',
  'close',
  'cancelled',
  'permissions_changed',
] as const;

import type { Mode } from './mode';
export type { Mode } from './mode';
export interface ShotView {
  round: number;
  from: number;
  to: number;
  latest: number;
  alpha: number;
}
export interface Command extends Input {
  seq: number;
  life: number;
  view?: ShotView;
}
export type RemoteState = Pick<Player, 'x' | 'y' | 'angle' | 'cooldown'> & {
  equipment: Pick<
    Equipment,
    'primary' | 'secondary' | 'shells' | 'charge' | 'sinceShot' | 'protection' | 'meleeDelay'
  >;
};
export interface LocalCheckpoint {
  id: number;
  state: Player;
  ack: number;
  seed: number;
  diedTick: number;
}
export type LocalPlayer = Omit<RemotePlayer, 'state'> & LocalCheckpoint;
export interface RemotePlayer {
  team: Team;
  nickname: string;
  nicknameColors?: string | undefined;
  appearance: Appearance;
  id: number;
  state: RemoteState;
  hp: number;
  status: 'spectator' | 'alive' | 'dead';
  life: number;
  bornTick: number;
}
interface Flag {
  team: 'blue' | 'red';
  state: 'home' | 'carried' | 'dropped';
  carrierId: number;
  position: { x: number; y: number };
}
export interface Match {
  scores: { blue: number; red: number };
  round: number;
  phase: 'playing' | 'intermission';
  startedTick: number;
  endsTick: number;
  rules: {
    mode: Mode;
    scoreLimit: number;
    timeLimitTicks: number;
    respawnTicks: number;
    endTicks: number;
    forceRespawn: boolean;
  };
  ranking: { team: Team; id: number; score: number; kills: number; deaths: number }[];
}
export interface Entity extends Motion {
  id: number;
  kind: string;
  expiresTick: number;
}
export type GroundItem = Omit<Entity, 'kind'> &
  ({ kind: 'weapon'; primary: Primary } | { kind: 'grenade' | 'health' });
export interface Projectile extends Entity {
  turret?: { angle: number; lastShotTick: number };
  kind: 'grenade' | 'molotov' | 'flame' | 'rocket' | 'minibot';
  ownerId: number;
  bornTick: number;
  attachedId: number;
}
export interface Snapshot {
  capturedAtMs: number;
  eventCut: number;
  flags: Flag[];
  match: Match;
  items: GroundItem[];
  projectiles: Projectile[];
  type: 'snapshot';
  version: number;
  tick: number;
  players: RemotePlayer[];
  local: LocalCheckpoint | null;
}

// Omission reuses the last transmitted field group within an ordered generation.
// Installation and the in-memory snapshot always contain the complete list.
type PlayerMetadata = Pick<RemotePlayer, 'team' | 'nickname' | 'nicknameColors' | 'appearance'>;
export interface EntityDelta<T> {
  upsert: T[];
  remove: number[];
}
export type StateUpdate = Omit<
  Snapshot,
  'items' | 'projectiles' | 'flags' | 'players' | 'match'
> & {
  flags?: Snapshot['flags'];
  items?: Snapshot['items'] | EntityDelta<Snapshot['items'][number]>;
  projectiles?: Snapshot['projectiles'] | EntityDelta<Projectile>;
  players: (Omit<RemotePlayer, keyof PlayerMetadata> & Partial<PlayerMetadata>)[];
  match: Omit<Match, 'rules' | 'scores' | 'ranking'> &
    Partial<Pick<Match, 'rules' | 'scores' | 'ranking'>>;
};

export const GAME_SIGNAL_KINDS = [
  'reload',
  'charge',
  'overheat',
  'shield',
  'throw',
  'bounce',
  'molotov-break',
  'pickup-health',
  'pickup-equipment',
  'pickup-grenade',
  'spawn',
  'shield-end',
  'chain-ready',
  'charge-ready',
  'minibot-start',
  'minibot-end',
  'fire-end',
] as const;
export type GameSignalKind = (typeof GAME_SIGNAL_KINDS)[number];
export interface ShotCue extends Pick<Shot, 'kind' | 'surface' | 'from' | 'to' | 'killed'> {
  pellets?: ShotCue[];
}
interface EventHeader {
  occurredAtMs: number;
  id: number;
  tick: number;
  round: number;
  ownerId: number;
  life: number;
  position: { x: number; y: number; z: number };
}
export type GameEvent = EventHeader &
  (
    | { kind: 'damage'; amount: number; sourceId?: number; weapon: string }
    | { kind: 'death'; sourceId?: number; weapon: string }
    | { kind: 'hit'; action: number }
    | { kind: 'phase'; phase: 'playing' | 'intermission' }
    | { kind: 'signal'; signal: Exclude<GameSignalKind, 'bounce' | 'molotov-break'> }
    | { kind: 'activity'; activity: Activity }
  );
export type GameCue = EventHeader &
  (
    | { kind: 'shot'; shot: ShotCue }
    | { kind: 'explosion' | 'rocket-explosion' | 'knives'; radius: number }
    | { kind: 'bounce' | 'molotov-break' | 'item-impact' | 'player-impact' | 'shield-hit' }
  );
export interface EventBatch {
  type: 'events';
  version: number;
  tick: number;
  after: number;
  through: number;
  events: GameEvent[];
  cues: GameCue[];
}
export interface Welcome {
  activities: Activity[];
  tick: number;
  eventCut: number;
  type: 'welcome' | 'map' | 'resync';
  round: number;
  version: number;
  id: number;
  tickHz: number;
  snapshotHz: number;
  arena: ArenaMap;
  shotGeometry: ShotGeometry;
}

export interface AdministrationNotice {
  type: 'administration';
  action: (typeof ADMINISTRATION_ACTIONS)[number];
  deadlineAtMs?: number;
  operation?: string;
}
export type ServerMessage =
  | Welcome
  | Snapshot
  | EventBatch
  | AdministrationNotice
  | { type: 'pong'; version: number; nonce: number; tick: number; receivedAtMs: number };
export type ClientMessage =
  | { type: 'input'; inputs: Command[] }
  | { type: 'join' | 'respawn' | 'release' }
  | { type: 'select'; primary: Primary; secondary: Secondary }
  | { type: 'appearance'; appearance: Appearance }
  | { type: 'profile'; nickname: string; nicknameColors?: string | undefined }
  | { type: 'resync' }
  | { type: 'receipt'; receipt: Receipt; immediate?: boolean };

export interface Receipt {
  connection: string;
  sequence: number;
  generation: number;
  eventThrough: number;
}
export type Delivery = Receipt & {
  type: 'delivery';
  version: number;
  sentAtMs: number;
} & (
    | { kind: 'installation'; body: Welcome & { state: Snapshot } }
    | { kind: 'state'; body: StateUpdate }
    | { kind: 'events' | 'cues'; body: EventBatch }
    | { kind: 'control'; body: AdministrationNotice }
    | { kind: 'probe'; body: Extract<ServerMessage, { type: 'pong' }> }
  );
export interface AuthorityTime {
  now: number;
  upper: number;
}
