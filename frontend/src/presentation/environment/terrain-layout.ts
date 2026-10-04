// Optional cosmetic sidecar selected by geometry, not by a community map's display name.
import type { ArenaMap } from '../../maps/types';
import type { TerrainArt } from './terrain';
function terrainKey(arena: ArenaMap): string {
  const source = JSON.stringify([
    arena.width === arena.height ? arena.width : [arena.width, arena.height],
    arena.walls.map((w) => [w.x, w.y, w.w, w.h, w.height ?? 1]),
  ]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++)
    hash = Math.imul(hash ^ source.charCodeAt(i), 16777619) >>> 0;
  return hash.toString(16);
}
export async function loadTerrainArt(arena: ArenaMap): Promise<TerrainArt | undefined> {
  const response = await fetch(`${import.meta.env.BASE_URL}assets/kit/terrain-layouts.json`);
  if (!response.ok) throw new Error(`Terrain art HTTP ${response.status}`);
  const catalog: unknown = await response.json();
  if (typeof catalog !== 'object' || catalog === null)
    throw new Error('Invalid terrain art catalog');
  const value = (catalog as Record<string, unknown>)[terrainKey(arena)];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid terrain paths');
  const paths = value.map((path: unknown) => {
    if (!Array.isArray(path) || path.length > 64) throw new Error('Invalid terrain path');
    return path.map((point: unknown) => {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !point.every(
          (v, i) =>
            typeof v === 'number' &&
            Number.isFinite(v) &&
            v >= 0 &&
            v <= (i === 0 ? arena.width : arena.height),
        )
      )
        throw new Error('Invalid terrain point');
      return { x: point[0] as number, y: point[1] as number };
    });
  });
  return { paths };
}
