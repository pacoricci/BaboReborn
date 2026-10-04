import type { ArenaMap, MapDecal } from '../../maps/types';
import { decalContains, isMapDecal, MAX_DECALS } from '../../maps/decals';
import type { Vec2 } from '../../core/geometry';

export function decalAt(map: ArenaMap, point: Vec2): number {
  // Last authored item is painted on top, so selection follows visual stacking.
  for (let i = (map.decals?.length ?? 0) - 1; i >= 0; i--)
    if (decalContains(map.decals![i]!, point)) return i;
  return -1;
}
export function placeDecal(map: ArenaMap, decal: MapDecal): ArenaMap {
  if ((map.decals?.length ?? 0) >= MAX_DECALS)
    throw new Error(`A map supports up to ${MAX_DECALS} decals.`);
  if (!isMapDecal(decal, map.width, map.height))
    throw new Error('Keep the whole decal inside the map.');
  return { ...map, decals: [...(map.decals ?? []), decal] };
}
export function changeDecal(map: ArenaMap, index: number, patch: Partial<MapDecal>): ArenaMap {
  const previous = map.decals?.[index];
  if (!previous) return map;
  const decal = { ...previous, ...patch };
  if (!isMapDecal(decal, map.width, map.height))
    throw new Error('Invalid decal size, rotation, opacity or bounds.');
  return { ...map, decals: map.decals.map((value, i) => (i === index ? decal : value)) };
}
export function removeDecal(map: ArenaMap, index: number): ArenaMap {
  return { ...map, decals: map.decals?.filter((_, i) => i !== index) ?? [] };
}
