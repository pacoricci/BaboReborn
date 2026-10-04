import type { ArenaMap } from './types';
import { MOVEMENT } from '../gameconfig/tuning';
import { isMapTheme } from './types';
import { isMapDecal, MAX_DECALS } from './decals';

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const whole = (v: unknown, min: number, max: number): v is number =>
  finite(v) && Number.isInteger(v) && v >= min && v <= max;

// The same authored contract is checked at file and wire boundaries, never each tick.
export function isArenaMap(v: unknown): v is ArenaMap {
  if (
    !record(v) ||
    v.schema !== 1 ||
    !isMapTheme(v.theme) ||
    typeof v.id !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,47}$/.test(v.id) ||
    ![v.name, v.author].every(
      (s) => typeof s === 'string' && s.trim().length > 0 && [...s].length <= 80,
    ) ||
    !whole(v.width, 8, 128) ||
    !whole(v.height, 8, 128) ||
    !Array.isArray(v.walls) ||
    v.walls.length > 4096 ||
    !Array.isArray(v.spawns) ||
    v.spawns.length < 1 ||
    v.spawns.length > 64
  )
    return false;
  const width = v.width,
    height = v.height;
  if (
    v.decals !== undefined &&
    (!Array.isArray(v.decals) ||
      v.decals.length > MAX_DECALS ||
      !v.decals.every((d: unknown) => isMapDecal(d, width, height)))
  )
    return false;
  if (
    !v.walls.every(
      (w: unknown) =>
        record(w) &&
        (w.material === undefined || isMapTheme(w.material)) &&
        whole(w.x, 0, width - 1) &&
        whole(w.y, 0, height - 1) &&
        whole(w.w, 1, width - w.x) &&
        whole(w.h, 1, height - w.y) &&
        (w.height === undefined || (finite(w.height) && w.height > 0 && w.height <= 64)),
    )
  )
    return false;
  const walls = v.walls as ArenaMap['walls'];
  const margin = MOVEMENT.radius + MOVEMENT.clearance;
  if (v.teams !== undefined) {
    if (!record(v.teams)) return false;
    for (const team of [v.teams.blue, v.teams.red]) {
      if (
        !record(team) ||
        !record(team.base) ||
        !Array.isArray(team.spawns) ||
        team.spawns.length < 1 ||
        team.spawns.length > 32 ||
        !isArenaMap({ ...v, teams: undefined, spawns: [team.base, ...(team.spawns as unknown[])] })
      )
        return false;
    }
    const teams = v.teams as unknown as NonNullable<ArenaMap['teams']>;
    if (Math.hypot(teams.blue.base.x - teams.red.base.x, teams.blue.base.y - teams.red.base.y) < 4)
      return false;
  }
  return v.spawns.every(
    (p: unknown) =>
      record(p) &&
      finite(p.x) &&
      finite(p.y) &&
      p.x >= 1 + margin &&
      p.y >= 1 + margin &&
      p.x <= width - 1 - margin &&
      p.y <= height - 1 - margin &&
      !walls.some(
        (w) =>
          Number(p.x) > w.x - margin &&
          Number(p.x) < w.x + w.w + margin &&
          Number(p.y) > w.y - margin &&
          Number(p.y) < w.y + w.h + margin,
      ),
  );
}
