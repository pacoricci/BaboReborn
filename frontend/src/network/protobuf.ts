import { fromBinary } from '@bufbuild/protobuf';
import { DeliverySchema } from './generated/snapshot_pb';
import type * as Wire from './generated/snapshot_pb';
import { decodePosition, decodeAngle } from './precision';

// Project generated records explicitly. Optional presence survives until the
// semantic validator checks required fields and game rules in protocol.ts.
// Proto2 keeps absent scalar defaults on the prototype. Only an own property
// denotes presence; reading value.field directly would invent omitted metadata.
function scalar<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
function integer(value: bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe protocol integer.');
  return n;
}
function optional<T, U>(value: T | undefined, convert: (value: T) => U): U | undefined {
  return value === undefined ? undefined : convert(value);
}
// Only remove absent fields from a newly constructed record, never from a
// generated message or a retained snapshot. No recursive copying.
function fields<T extends object>(value: T): T {
  for (const key in value) if (value[key] === undefined) delete value[key];
  return value;
}

export function decodeSnapshotDelivery(bytes: Uint8Array) {
  const value = fromBinary(DeliverySchema, bytes, { readUnknownFields: false });
  if (value.kind !== 'state') throw new Error('Unexpected binary delivery kind.');
  if (!value.body) throw new Error('Missing binary state.');
  return fields({
    type: scalar(value, 'type'),
    version: scalar(value, 'version'),
    connection: scalar(value, 'connection'),
    sequence: integer(scalar(value, 'sequence')),
    generation: integer(scalar(value, 'generation')),
    eventThrough: integer(scalar(value, 'eventThrough')),
    sentAtMs: integer(scalar(value, 'sentAtMs')),
    kind: scalar(value, 'kind'),
    body: snapshot(value.body),
  });
}

function entities<T, U>(
  group: { delta?: boolean | undefined; values: T[]; upsert: T[]; remove: bigint[] } | undefined,
  convert: (value: T) => U,
) {
  if (!group) return undefined;
  if (group.delta) {
    if (group.values.length) throw new Error('Mixed entity group.');
    return { upsert: group.upsert.map(convert), remove: group.remove.map(integer) };
  }
  if (group.upsert.length || group.remove.length) throw new Error('Mixed entity group.');
  return group.values.map(convert);
}

function snapshot(value: Wire.Snapshot) {
  return fields({
    capturedAtMs: integer(scalar(value, 'capturedAtMs')),
    eventCut: integer(scalar(value, 'eventCut')),
    match: optional(value.match, match),
    players: value.players.map(player),
    local: optional(value.local, local) ?? null,
    type: scalar(value, 'type'),
    version: scalar(value, 'version'),
    tick: integer(scalar(value, 'tick')),
    flags: value.flags?.values.map(flag),
    items: entities(value.items, item),
    projectiles: entities(value.projectiles, projectile),
  });
}

function appearance(value: Wire.Appearance) {
  return fields({
    template: scalar(value, 'template'),
    colors: value.colors,
  });
}

function player(value: Wire.Player) {
  return fields({
    id: integer(scalar(value, 'id')),
    hp: scalar(value, 'hp'),
    status: scalar(value, 'status'),
    life: integer(scalar(value, 'life')),
    bornTick: integer(scalar(value, 'bornTick')),
    state: optional(value.state, remoteState),
    team: scalar(value, 'team'),
    nickname: scalar(value, 'nickname'),
    appearance: optional(value.appearance, appearance),
    nicknameColors: scalar(value, 'nicknameColors'),
  });
}

function remoteState(value: Wire.RemoteState) {
  return fields({
    x: optional(scalar(value, 'x'), decodePosition),
    y: optional(scalar(value, 'y'), decodePosition),
    angle: optional(scalar(value, 'angle'), decodeAngle),
    cooldown: scalar(value, 'cooldown'),
    equipment: optional(value.equipment, remoteEquipment),
  });
}

function remoteEquipment(value: Wire.RemoteEquipment) {
  return fields({
    primary: scalar(value, 'primary'),
    secondary: scalar(value, 'secondary'),
    shells: scalar(value, 'shells'),
    charge: scalar(value, 'charge'),
    sinceShot: scalar(value, 'sinceShot'),
    protection: scalar(value, 'protection'),
    meleeDelay: scalar(value, 'meleeDelay'),
  });
}

function local(value: Wire.Local) {
  return fields({
    id: integer(scalar(value, 'id')),
    state: optional(value.state, state),
    ack: integer(scalar(value, 'ack')),
    diedTick: integer(scalar(value, 'diedTick')),
    seed: scalar(value, 'seed'),
  });
}

function state(value: Wire.State) {
  return fields({
    x: scalar(value, 'x'),
    y: scalar(value, 'y'),
    vx: scalar(value, 'vx'),
    vy: scalar(value, 'vy'),
    angle: scalar(value, 'angle'),
    cooldown: scalar(value, 'cooldown'),
    spread: scalar(value, 'spread'),
    equipment: optional(value.equipment, equipment),
  });
}

function equipment(value: Wire.Equipment) {
  return fields({
    heat: scalar(value, 'heat'),
    overheated: scalar(value, 'overheated'),
    charge: scalar(value, 'charge'),
    fireTime: scalar(value, 'fireTime'),
    sinceShot: scalar(value, 'sinceShot'),
    scopeHeight: scalar(value, 'scopeHeight'),
    rocketActive: scalar(value, 'rocketActive'),
    rocketAge: scalar(value, 'rocketAge'),
    primaryAction: scalar(value, 'primaryAction'),
    barrel: scalar(value, 'barrel'),
    secondaryActivated: scalar(value, 'secondaryActivated'),
    primary: scalar(value, 'primary'),
    secondary: scalar(value, 'secondary'),
    grenades: scalar(value, 'grenades'),
    molotovs: scalar(value, 'molotovs'),
    shells: scalar(value, 'shells'),
    meleeDelay: scalar(value, 'meleeDelay'),
    throwDelay: scalar(value, 'throwDelay'),
    protection: scalar(value, 'protection'),
    action: scalar(value, 'action'),
  });
}

function match(value: Wire.Match) {
  return fields({
    round: integer(scalar(value, 'round')),
    phase: scalar(value, 'phase'),
    startedTick: integer(scalar(value, 'startedTick')),
    endsTick: integer(scalar(value, 'endsTick')),
    rules: optional(value.rules, rules),
    scores: optional(value.scores, scores),
    ranking: value.ranking?.values.map(standing),
  });
}

function rules(value: Wire.Rules) {
  return fields({
    mode: scalar(value, 'mode'),
    scoreLimit: integer(scalar(value, 'scoreLimit')),
    timeLimitTicks: integer(scalar(value, 'timeLimitTicks')),
    respawnTicks: integer(scalar(value, 'respawnTicks')),
    endTicks: integer(scalar(value, 'endTicks')),
    forceRespawn: scalar(value, 'forceRespawn'),
  });
}

function scores(value: Wire.Scores) {
  return fields({
    blue: integer(scalar(value, 'blue')),
    red: integer(scalar(value, 'red')),
  });
}

function standing(value: Wire.Standing) {
  return fields({
    id: integer(scalar(value, 'id')),
    team: scalar(value, 'team'),
    score: integer(scalar(value, 'score')),
    kills: integer(scalar(value, 'kills')),
    deaths: integer(scalar(value, 'deaths')),
  });
}

function point(value: Wire.Point) {
  return fields({
    x: scalar(value, 'x'),
    y: scalar(value, 'y'),
  });
}

function vec3(value: Wire.Vec3) {
  return fields({
    x: scalar(value, 'x'),
    y: scalar(value, 'y'),
    z: scalar(value, 'z'),
  });
}

function flag(value: Wire.Flag) {
  return fields({
    team: scalar(value, 'team'),
    state: scalar(value, 'state'),
    carrierId: integer(scalar(value, 'carrierId')),
    position: optional(value.position, point),
  });
}

function item(value: Wire.Item) {
  return fields({
    id: integer(scalar(value, 'id')),
    motion: scalar(value, 'motion'),
    motionTick: integer(scalar(value, 'motionTick')),
    position: optional(value.position, vec3),
    velocity: optional(value.velocity, vec3),
    expiresTick: integer(scalar(value, 'expiresTick')),
    kind: scalar(value, 'kind'),
    primary: scalar(value, 'primary'),
  });
}

function projectile(value: Wire.Projectile) {
  return fields({
    id: integer(scalar(value, 'id')),
    motion: scalar(value, 'motion'),
    motionTick: integer(scalar(value, 'motionTick')),
    position: optional(value.position, vec3),
    velocity: optional(value.velocity, vec3),
    expiresTick: integer(scalar(value, 'expiresTick')),
    kind: scalar(value, 'kind'),
    ownerId: integer(scalar(value, 'ownerId')),
    bornTick: integer(scalar(value, 'bornTick')),
    attachedId: integer(scalar(value, 'attachedId')),
    turret: optional(value.turret, turret),
  });
}

function turret(value: Wire.Turret) {
  return fields({
    angle: scalar(value, 'angle'),
    lastShotTick: integer(scalar(value, 'lastShotTick')),
  });
}
