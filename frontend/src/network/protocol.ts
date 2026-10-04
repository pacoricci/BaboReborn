import { validNicknameColors } from '../player/nickname';
import { decodeSnapshotDelivery } from './protobuf';
import { payloadBytes } from './payload';
import { isTeam } from '../contracts/activity';
import { isArenaMap } from '../maps/validation';
import { isPrimary, isSecondary } from '../core/equipment';
import { TICK_HZ } from '../core/timing';
import { GRENADE, MOLOTOV, SHOTGUN, BAZOOKA, KNIVES, SNIPER } from '../gameconfig/tuning';
// Validate untrusted wire data at the adapter boundary, without copying tick state.
import { isAppearance } from '../player/appearance';
import { isMode } from '../contracts/mode';
import { ADMINISTRATION_ACTIONS, PROTOCOL, GAME_SIGNAL_KINDS } from '../contracts/session';
import type {
  StateUpdate,
  Welcome,
  EventBatch,
  ServerMessage,
  Delivery,
} from '../contracts/session';

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bounded = (v: unknown, low: number, high = Infinity): boolean =>
  finite(v) && v >= low && v <= high;
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const numbers = (v: unknown, keys: string[]): v is RecordValue =>
  record(v) && keys.every((k) => finite(v[k]));
const oneOfStrings = (v: unknown, choices: readonly string[]): boolean =>
  typeof v === 'string' && choices.includes(v);
const roster = (v: unknown, check: (item: unknown) => boolean): boolean => {
  // Match the authority's room capacity; player IDs keep increasing after departures.
  if (!Array.isArray(v) || v.length > 16) return false;
  const ids = new Set<number>();
  return v.every((item: unknown) => {
    if (!record(item) || !integer(item.id) || ids.has(item.id) || !check(item)) return false;
    ids.add(item.id);
    return true;
  });
};
const entityList = (v: unknown, check: (item: unknown) => boolean): boolean => {
  if (!Array.isArray(v)) return false;
  const ids = new Set<number>();
  return v.every((item) => {
    if (!record(item) || !integer(item.id) || ids.has(item.id) || !check(item)) return false;
    ids.add(item.id);
    return true;
  });
};
const entityUpdate = (
  v: unknown,
  check: (item: unknown) => boolean,
  retained: boolean,
): boolean => {
  if (!retained) return entityList(v, check);
  if (v === undefined) return true;
  if (!record(v) || !entityList(v.upsert, check) || !Array.isArray(v.remove)) return false;
  const ids = new Set((v.upsert as { id: number }[]).map((e) => e.id));
  return v.remove.every((id) => {
    if (!integer(id) || ids.has(id)) return false;
    ids.add(id);
    return true;
  });
};
const point3 = (v: unknown) => numbers(v, ['x', 'y', 'z']);
const damageWeapon = (v: unknown) =>
  isPrimary(v) || isSecondary(v) || v === 'grenade' || v === 'molotov';
const equipment = (v: unknown) =>
  record(v) &&
  isPrimary(v.primary) &&
  isSecondary(v.secondary) &&
  numbers(v, ['grenades', 'molotovs', 'shells', 'meleeDelay', 'throwDelay', 'protection']) &&
  numbers(v, ['heat', 'charge', 'fireTime', 'sinceShot', 'scopeHeight', 'rocketAge', 'barrel']) &&
  bounded(v.heat, 0, 1) &&
  bounded(v.charge, 0) &&
  bounded(v.fireTime, 0) &&
  bounded(v.sinceShot, 0) &&
  bounded(v.scopeHeight, SNIPER.minHeight, SNIPER.maxHeight) &&
  bounded(v.rocketAge, 0) &&
  integer(v.barrel) &&
  v.barrel < (v.primary === 'chain' ? 4 : 2) &&
  typeof v.overheated === 'boolean' &&
  typeof v.rocketActive === 'boolean' &&
  oneOfStrings(v.primaryAction, ['', 'rocket', 'detonate']) &&
  integer(v.grenades) &&
  v.grenades <= GRENADE.maxCarry &&
  integer(v.molotovs) &&
  v.molotovs <= MOLOTOV.spawnCount &&
  typeof v.secondaryActivated === 'boolean' &&
  integer(v.shells) &&
  v.shells <= SHOTGUN.shells &&
  oneOfStrings(v.action, ['', 'knives', 'shield', 'minibot', 'grenade', 'molotov']);
const playerState = (v: unknown) =>
  numbers(v, ['x', 'y', 'vx', 'vy', 'angle', 'cooldown', 'spread']) && equipment(v.equipment);
const remoteState = (v: unknown) =>
  numbers(v, ['x', 'y', 'angle', 'cooldown']) &&
  v.vx === undefined &&
  v.vy === undefined &&
  v.spread === undefined &&
  record(v.equipment) &&
  Object.keys(v.equipment).every((k) =>
    ['primary', 'secondary', 'shells', 'charge', 'sinceShot', 'protection', 'meleeDelay'].includes(
      k,
    ),
  ) &&
  isPrimary(v.equipment.primary) &&
  isSecondary(v.equipment.secondary) &&
  integer(v.equipment.shells) &&
  v.equipment.shells <= SHOTGUN.shells &&
  ['charge', 'sinceShot', 'protection', 'meleeDelay'].every((k) =>
    bounded((v.equipment as RecordValue)[k], 0),
  );
const localCheckpoint = (v: unknown, players: unknown) =>
  v === null ||
  (record(v) &&
    integer(v.id) &&
    integer(v.ack) &&
    finite(v.diedTick) &&
    integer(v.seed) &&
    playerState(v.state) &&
    Array.isArray(players) &&
    players.some((p: unknown) => record(p) && p.id === v.id));
const match = (v: unknown, retained = false) =>
  record(v) &&
  integer(v.round) &&
  oneOfStrings(v.phase, ['playing', 'intermission']) &&
  integer(v.startedTick) &&
  integer(v.endsTick) &&
  ((retained && v.scores === undefined && v.ranking === undefined) ||
    (record(v.scores) &&
      Number.isSafeInteger(v.scores.blue) &&
      Number.isSafeInteger(v.scores.red) &&
      roster(v.ranking, (r) => numbers(r, ['score', 'kills', 'deaths']) && isTeam(r.team)))) &&
  ((retained && v.rules === undefined) ||
    (record(v.rules) &&
      isMode(v.rules.mode) &&
      ['scoreLimit', 'timeLimitTicks', 'respawnTicks', 'endTicks'].every((k) =>
        integer((v.rules as RecordValue)[k]),
      ) &&
      typeof v.rules.forceRespawn === 'boolean'));
const entity = (v: unknown) =>
  record(v) &&
  integer(v.id) &&
  point3(v.position) &&
  point3(v.velocity) &&
  integer(v.expiresTick) &&
  integer(v.motionTick) &&
  oneOfStrings(v.motion, ['fixed', 'bounce', 'fall', 'rocket', 'attached']);

// Human names remain ASCII; the authority prefixes generated bot names with an icon.
const serverNickname = (v: unknown): v is string =>
  typeof v === 'string' && (/^[A-Za-z0-9 _-]{1,20}$/.test(v) || /^▣ Bot [0-9]{2,16}$/.test(v));
const participant = (v: unknown) =>
  record(v) &&
  integer(v.id) &&
  isTeam(v.team) &&
  serverNickname(v.nickname) &&
  validNicknameColors(v.nicknameColors, v.nickname);
const activity = (v: unknown, tick: number, round: number) =>
  record(v) &&
  integer(v.id) &&
  integer(v.occurredAtMs) &&
  integer(v.tick) &&
  v.tick <= tick &&
  v.round === round &&
  participant(v.actor) &&
  (v.kind === 'kill'
    ? participant(v.victim) && damageWeapon(v.weapon)
    : oneOfStrings(v.kind, [
        'connected',
        'disconnected',
        'flag-take',
        'flag-drop',
        'flag-return',
        'flag-capture',
      ]) &&
      v.victim === undefined &&
      v.weapon === undefined);
const player = (v: unknown, retained = false) =>
  record(v) &&
  integer(v.id) &&
  ((retained &&
    v.team === undefined &&
    v.nickname === undefined &&
    v.nicknameColors === undefined &&
    v.appearance === undefined) ||
    (isTeam(v.team) &&
      serverNickname(v.nickname) &&
      validNicknameColors(v.nicknameColors, v.nickname) &&
      isAppearance(v.appearance))) &&
  remoteState(v.state) &&
  v.diedTick === undefined &&
  numbers(v, ['hp', 'bornTick']) &&
  integer(v.life) &&
  v.ack === undefined &&
  v.seed === undefined &&
  oneOfStrings(v.status, ['spectator', 'alive', 'dead']);
const shot = (v: unknown): boolean =>
  record(v) &&
  (v.surface === undefined || typeof v.surface === 'boolean') &&
  (v.kind === undefined || isPrimary(v.kind) || v.kind === 'minibot') &&
  point3(v.from) &&
  point3(v.to) &&
  typeof v.killed === 'boolean' &&
  (v.pellets === undefined ||
    (Array.isArray(v.pellets) &&
      [2, 3, SHOTGUN.pellets].includes(v.pellets.length) &&
      v.pellets.every((p) => record(p) && p.pellets === undefined && shot(p))));

function flags(v: RecordValue, retained = false): boolean {
  if (retained && v.flags === undefined) return true;
  if (
    !record(v.match) ||
    !((retained && v.match.rules === undefined) || record(v.match.rules)) ||
    !Array.isArray(v.flags) ||
    !Array.isArray(v.players)
  )
    return false;
  const mode = record(v.match.rules) ? v.match.rules.mode : undefined;
  if (mode !== undefined && mode !== 'ctf') return v.flags.length === 0;
  if (v.flags.length === 0) return retained && mode === undefined;
  if (v.flags.length !== 2) return false;
  const teams = new Set<string>();
  const carriers = new Set<number>();
  return v.flags.every((f: unknown) => {
    if (
      !record(f) ||
      !oneOfStrings(f.team, ['blue', 'red']) ||
      teams.has(String(f.team)) ||
      !oneOfStrings(f.state, ['home', 'carried', 'dropped']) ||
      !integer(f.carrierId) ||
      !numbers(f.position, ['x', 'y']) ||
      !bounded(f.position.x, 0, 128) ||
      !bounded(f.position.y, 0, 128)
    )
      return false;
    teams.add(String(f.team));
    if (f.state !== 'carried') return f.carrierId === 0;
    if (f.carrierId === 0 || carriers.has(f.carrierId)) return false;
    carriers.add(f.carrierId);
    return (v.players as unknown[]).some(
      (p) =>
        record(p) &&
        p.id === f.carrierId &&
        p.status === 'alive' &&
        ((retained && p.team === undefined) || (p.team !== f.team && p.team !== 'none')),
    );
  });
}

const eventHeader = (e: unknown, tick: number): e is RecordValue =>
  record(e) &&
  integer(e.id) &&
  integer(e.occurredAtMs) &&
  e.id > 0 &&
  integer(e.tick) &&
  e.tick <= tick &&
  integer(e.round) &&
  e.round > 0 &&
  integer(e.ownerId) &&
  integer(e.life) &&
  point3(e.position);
const requiredEvent = (e: RecordValue): boolean => {
  switch (e.kind) {
    case 'damage':
    case 'death':
      return (
        (e.ownerId as number) > 0 &&
        damageWeapon(e.weapon) &&
        (e.sourceId === undefined || integer(e.sourceId)) &&
        (e.kind === 'death' || (finite(e.amount) && e.amount > 0))
      );
    case 'hit':
      return (e.ownerId as number) > 0 && integer(e.action) && e.action > 0;
    case 'phase':
      return oneOfStrings(e.phase, ['playing', 'intermission']);
    case 'signal':
      return (
        (e.ownerId as number) > 0 &&
        oneOfStrings(e.signal, GAME_SIGNAL_KINDS) &&
        e.signal !== 'bounce' &&
        e.signal !== 'molotov-break'
      );
    case 'activity':
      return (
        activity(e.activity, e.tick as number, e.round as number) &&
        record(e.activity) &&
        e.activity.id === e.id
      );
    default:
      return false;
  }
};
const visualCue = (c: RecordValue): boolean => {
  switch (c.kind) {
    case 'shot':
      return shot(c.shot);
    case 'explosion':
    case 'rocket-explosion':
    case 'knives':
      return (
        finite(c.radius) &&
        c.radius > 0 &&
        c.radius <= Math.max(GRENADE.visualRadius, BAZOOKA.radius, KNIVES.radius)
      );
    case 'bounce':
    case 'molotov-break':
    case 'shield-hit':
    case 'item-impact':
    case 'player-impact':
      return true;
    default:
      return false;
  }
};
function eventBatch(v: RecordValue): boolean {
  if (
    !integer(v.tick) ||
    !integer(v.after) ||
    !integer(v.through) ||
    v.after > v.through ||
    !Array.isArray(v.events) ||
    !Array.isArray(v.cues)
  )
    return false;
  let last = v.after;
  for (const e of v.events) {
    if (
      !eventHeader(e, v.tick) ||
      (e.id as number) <= last ||
      (e.id as number) > v.through ||
      !requiredEvent(e)
    )
      return false;
    last = e.id as number;
  }
  last = 0;
  for (const c of v.cues) {
    if (!eventHeader(c, v.tick) || (c.id as number) <= last || !visualCue(c)) return false;
    last = c.id as number;
  }
  return true;
}

export function parseServerMessage(data: unknown): ServerMessage {
  if (typeof data !== 'string') throw new Error('Expected a text server message.');
  return parseValue(JSON.parse(data));
}
function parseValue(value: unknown): ServerMessage;
function parseValue(value: unknown, retained: boolean): ServerMessage | StateUpdate;
function parseValue(value: unknown, retained = false): ServerMessage | StateUpdate {
  if (!record(value)) throw new Error('Malformed server message.');
  if (
    value.type === 'administration' &&
    oneOfStrings(value.action, ADMINISTRATION_ACTIONS) &&
    (value.deadlineAtMs === undefined || integer(value.deadlineAtMs)) &&
    (value.operation === undefined ||
      (typeof value.operation === 'string' && /^[a-f0-9]{32}$/.test(value.operation)))
  )
    return value as unknown as ServerMessage;
  if (
    value.type === 'pong' &&
    value.version === PROTOCOL &&
    finite(value.nonce) &&
    integer(value.tick) &&
    integer(value.receivedAtMs)
  )
    return value as ServerMessage;
  if (value.version !== PROTOCOL) throw new Error('Incompatible server protocol.');
  if (value.type === 'events' && eventBatch(value)) return value as unknown as EventBatch;
  if (
    value.type === 'snapshot' &&
    integer(value.capturedAtMs) &&
    value.events === undefined &&
    value.effects === undefined &&
    value.signals === undefined &&
    value.activities === undefined &&
    integer(value.tick) &&
    match(value.match, retained) &&
    flags(value, retained) &&
    integer(value.eventCut) &&
    entityUpdate(
      value.items,
      (v) =>
        record(v) &&
        integer(v.id) &&
        entity(v) &&
        finite(value.tick) &&
        finite(v.motionTick) &&
        v.motionTick <= value.tick &&
        oneOfStrings(v.kind, ['weapon', 'grenade', 'health']) &&
        (v.kind === 'weapon' ? isPrimary(v.primary) : v.primary === undefined),
      retained,
    ) &&
    entityUpdate(
      value.projectiles,
      (v) =>
        entity(v) &&
        record(v) &&
        oneOfStrings(v.kind, ['grenade', 'molotov', 'flame', 'rocket', 'minibot']) &&
        integer(v.ownerId) &&
        integer(v.bornTick) &&
        finite(value.tick) &&
        finite(v.motionTick) &&
        v.motionTick <= value.tick &&
        integer(v.attachedId) &&
        (v.kind === 'minibot'
          ? record(v.turret) &&
            bounded(v.turret.angle, -Math.PI, Math.PI) &&
            integer(v.turret.lastShotTick) &&
            finite(value.tick) &&
            v.turret.lastShotTick <= value.tick
          : v.turret === undefined),
      retained,
    ) &&
    roster(value.players, (v) => player(v, retained)) &&
    localCheckpoint(value.local, value.players)
  ) {
    return value as unknown as StateUpdate;
  }
  if (
    (value.type === 'welcome' || value.type === 'map' || value.type === 'resync') &&
    integer(value.tick) &&
    integer(value.eventCut) &&
    integer(value.round) &&
    value.round > 0 &&
    Array.isArray(value.activities) &&
    value.activities.length <= 64 &&
    value.activities.every((e: unknown) =>
      activity(e, value.tick as number, value.round as number),
    ) &&
    integer(value.id) &&
    value.tickHz === TICK_HZ &&
    finite(value.snapshotHz) &&
    value.snapshotHz > 0 &&
    value.snapshotHz <= value.tickHz &&
    isArenaMap(value.arena) &&
    numbers(value.shotGeometry, [
      'muzzleOffset',
      'muzzleSide',
      'muzzleHeight',
      'maxDistance',
      'wallHeight',
    ])
  ) {
    return value as unknown as Welcome;
  }
  throw new Error('Malformed server message.');
}

// Active sockets accept only bounded, versioned delivery envelopes. Body parsing
// is also exported for independent checkpoint and event contract fixtures.
export function parseDelivery(data: unknown): Delivery {
  const binary = data instanceof ArrayBuffer || data instanceof Uint8Array;
  if (!(typeof data === 'string' || binary) || payloadBytes(data) > 2 * 1024 * 1024)
    throw new Error('Oversized or unsupported delivery.');
  const v: unknown = binary
    ? decodeSnapshotDelivery(data instanceof Uint8Array ? data : new Uint8Array(data))
    : JSON.parse(data);
  if (!binary && record(v) && v.kind === 'state') throw new Error('Snapshot requires Protobuf.');
  if (
    !record(v) ||
    v.type !== 'delivery' ||
    v.version !== PROTOCOL ||
    typeof v.connection !== 'string' ||
    !v.connection.length ||
    v.connection.length > 128 ||
    !integer(v.sequence) ||
    v.sequence < 1 ||
    !integer(v.generation) ||
    v.generation < 1 ||
    !integer(v.eventThrough) ||
    !integer(v.sentAtMs) ||
    !record(v.body)
  )
    throw new Error('Malformed delivery envelope.');
  const b = parseValue(v.body, v.kind === 'state');
  let valid = false;
  switch (v.kind) {
    case 'installation': {
      if (b.type !== 'welcome' && b.type !== 'map' && b.type !== 'resync') break;
      const state = parseValue(v.body.state);
      valid =
        state.type === 'snapshot' &&
        state.tick === b.tick &&
        state.eventCut === b.eventCut &&
        state.match.round === b.round &&
        state.local?.id === b.id &&
        state.capturedAtMs <= v.sentAtMs;
      break;
    }
    case 'state':
      valid = b.type === 'snapshot' && b.capturedAtMs <= v.sentAtMs;
      break;
    case 'events':
    case 'cues':
      valid =
        b.type === 'events' &&
        b.events.length <= 256 &&
        b.cues.length <= 160 &&
        b.events.every((e) => e.occurredAtMs <= (v.sentAtMs as number)) &&
        b.cues.every((c) => c.occurredAtMs <= (v.sentAtMs as number)) &&
        b.through === v.eventThrough &&
        (v.kind === 'events'
          ? b.cues.length === 0
          : b.events.length === 0 && b.after === b.through);
      break;
    case 'control':
      valid = b.type === 'administration';
      break;
    case 'probe':
      valid = b.type === 'pong' && b.receivedAtMs <= v.sentAtMs;
      break;
  }
  if (!valid) throw new Error('Delivery kind does not match its body.');
  return v as unknown as Delivery;
}
