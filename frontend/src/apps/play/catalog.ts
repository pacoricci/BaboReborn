import { parseRoomReference } from '../../navigation/room-reference';
import { isMode } from '../../contracts/mode';
import type { Mode } from '../../contracts/mode';
import { isRoomDetails } from '../../contracts/server';
import type { RoomDetails } from '../../contracts/server';

export interface CatalogRoom {
  ref: string;
  id: string;
  name: string;
  mode: Mode;
  map: string;
  details: RoomDetails;
  occupied: number;
  capacity: number;
  serverName: string;
  serverOrigin: string;
  region: string;
  updatedAt: string;
}
export interface RoomCatalog {
  schema: 1;
  rooms: CatalogRoom[];
  updatedAt: string;
}
export function parseCatalog(raw: unknown): RoomCatalog {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid room catalog.');
  const c = raw as RoomCatalog;
  if (c.schema !== 1 || !Array.isArray(c.rooms) || !Number.isFinite(Date.parse(c.updatedAt)))
    throw new Error('Invalid room catalog.');
  const seen = new Set<string>();
  for (const room of c.rooms) {
    if (!room || typeof room.ref !== 'string') throw new Error('Invalid room reference.');
    const id = parseRoomReference(room.ref);
    if (
      room.id !== id.roomID ||
      seen.has(room.ref) ||
      ![room.name, room.map, room.serverName, room.serverOrigin, room.region].every(
        (v) => typeof v === 'string' && v.length <= 320,
      ) ||
      !room.name ||
      !isMode(room.mode) ||
      !Number.isInteger(room.occupied) ||
      !Number.isInteger(room.capacity) ||
      room.capacity < 2 ||
      room.capacity > 16 ||
      room.occupied < 0 ||
      room.occupied > room.capacity ||
      !Number.isFinite(Date.parse(room.updatedAt))
    )
      throw new Error('Invalid room catalog.');
    if (!isRoomDetails(room.details, room.occupied)) throw new Error('Invalid room details.');
    seen.add(room.ref);
  }
  return c;
}
export interface Filters {
  query: string;
  mode: string;
  hideFull?: boolean;
  withPlayers?: boolean;
  sort?: 'recommended' | 'players' | 'ping';
  favorites?: readonly string[];
  pings?: Readonly<Record<string, number | undefined>>;
}
export function visibleRooms(rooms: readonly CatalogRoom[], filters: Filters): CatalogRoom[] {
  const query = filters.query.trim().normalize('NFKC').toLowerCase();
  return rooms
    .filter(
      (room) =>
        room.name.normalize('NFKC').toLowerCase().includes(query) &&
        (!filters.mode || room.mode === filters.mode) &&
        (!filters.hideFull || room.occupied < room.capacity) &&
        (!filters.withPlayers || room.details.players > 0),
    )
    .sort((a, b) => {
      const players = b.details.players - a.details.players;
      const ping =
        (filters.pings?.[a.serverOrigin] ?? Infinity) -
        (filters.pings?.[b.serverOrigin] ?? Infinity);
      const name = a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref);
      if (filters.sort === 'players') return players || ping || name;
      if (filters.sort === 'ping') return ping || players || name;
      const favorite =
        Number(filters.favorites?.includes(b.ref) ?? false) -
        Number(filters.favorites?.includes(a.ref) ?? false);
      const full = Number(a.occupied >= a.capacity) - Number(b.occupied >= b.capacity);
      return favorite || full || players || ping || name;
    });
}

export const MODE_OBJECTIVES: Readonly<Record<Mode, string>> = {
  dm: 'Every player for themselves. Score by eliminating opponents.',
  tdm: 'Eliminate opponents to score for your team.',
  ctf: 'Bring the enemy flag to your base while your own flag is home.',
};
