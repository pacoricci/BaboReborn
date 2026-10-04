import type { Mode } from './mode';

export interface RoomDetails {
  players: number;
  bots: number;
  spectators: number;
  mapId: string;
  scoreLimit: number;
  timeLimitSeconds: number;
}

export function isRoomDetails(value: unknown, occupied: number): value is RoomDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const details = value as RoomDetails;
  return (
    [
      details.players,
      details.bots,
      details.spectators,
      details.scoreLimit,
      details.timeLimitSeconds,
    ].every((number) => Number.isSafeInteger(number) && number >= 0) &&
    details.players + details.bots + details.spectators === occupied &&
    typeof details.mapId === 'string' &&
    details.mapId.length > 0 &&
    details.mapId.length <= 320
  );
}

export interface ServerInfo {
  schema: 1;
  details: RoomDetails;
  name: string;
  mode: Mode;
  map: string;
  protocol: number;
  profile: string;
  occupied: number;
  capacity: number;
}

export interface RoomConfig {
  mode: Mode;
  name: string;
  capacity: number;
  bots: number;
  rotation: string[];
  scoreLimit: number;
  timeLimitMinutes: number;
  respawnSeconds: number;
  forceRespawn: boolean;
}
export interface ManagedRoomDirectory {
  schema: 1;
  rooms: { id: string; info: ServerInfo }[];
  maps: { id: string; name: string; ctf: boolean }[];
  maxRooms: number;
  createdRoomId?: string;
}

export interface ServerIdentity {
  subject: string;
  role: string;
  loginAvailable: boolean;
  central: string;
  expired: boolean;
}

// HTTP dates are RFC3339 strings in UTC; nullable dates retain their API meaning.
export interface Restriction {
  id: string;
  kind: string;
  target: string;
  actor: string;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}
