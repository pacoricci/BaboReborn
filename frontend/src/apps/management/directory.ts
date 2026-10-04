import { parseServerInfo } from '../../network/discovery';
import type { ManagedRoomDirectory } from '../../contracts/server';
export type { RoomConfig, ManagedRoomDirectory } from '../../contracts/server';

export function parseManagedRooms(raw: unknown): ManagedRoomDirectory {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid room list.');
  const d = raw as ManagedRoomDirectory;
  const id = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
  if (
    d.schema !== 1 ||
    !Array.isArray(d.rooms) ||
    d.rooms.length > 32 ||
    !Array.isArray(d.maps) ||
    d.maps.length < 1 ||
    d.maps.length > 256 ||
    !Number.isSafeInteger(d.maxRooms) ||
    d.maxRooms < 1 ||
    d.maxRooms > 32 ||
    (d.createdRoomId !== undefined && (!id(d.createdRoomId) || !d.createdRoomId))
  )
    throw new Error('Invalid room list.');
  for (const room of d.rooms) {
    if (!room || !id(room.id)) throw new Error('Invalid room address.');
    parseServerInfo(room.info);
  }
  if (
    new Set(d.rooms.map((r) => r.id)).size !== d.rooms.length ||
    (d.createdRoomId && !d.rooms.some((r) => r.id === d.createdRoomId))
  )
    throw new Error('Invalid room list.');
  for (const map of d.maps) {
    if (
      !map ||
      typeof map.ctf !== 'boolean' ||
      typeof map.id !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(map.id) ||
      typeof map.name !== 'string' ||
      !map.name ||
      map.name.length > 80
    )
      throw new Error('Invalid map catalog.');
  }
  return d;
}
