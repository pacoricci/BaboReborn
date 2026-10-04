import { isMapTheme } from './types';
import type { MapDecal } from './types';
import type { Vec2 } from '../core/geometry';

export const MAX_DECALS = 64;
export const MIN_DECAL_SIZE = 0.05; // [cells]
export const MAX_DECAL_SIZE = 32; // [cells]
const fields = ['asset', 'x', 'y', 'w', 'h', 'angle', 'opacity'];
export function isMapDecal(value: unknown, width: number, height: number): value is MapDecal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if (!isMapTheme(d.asset) || Object.keys(d).some((key) => !fields.includes(key))) return false;
  for (const key of fields.slice(1))
    if (typeof d[key] !== 'number' || !Number.isFinite(d[key])) return false;
  const decal = d as unknown as MapDecal;
  if (
    decal.w < MIN_DECAL_SIZE ||
    decal.w > MAX_DECAL_SIZE ||
    decal.h < MIN_DECAL_SIZE ||
    decal.h > MAX_DECAL_SIZE ||
    Math.abs(decal.angle) > Math.PI ||
    decal.opacity < 0 ||
    decal.opacity > 1
  )
    return false;
  const c = Math.abs(Math.cos(decal.angle)),
    s = Math.abs(Math.sin(decal.angle));
  const x = (c * decal.w + s * decal.h) / 2,
    y = (s * decal.w + c * decal.h) / 2;
  return decal.x >= x && decal.x <= width - x && decal.y >= y && decal.y <= height - y;
}
export function decalContains(decal: MapDecal, point: Vec2): boolean {
  const dx = point.x - decal.x,
    dy = point.y - decal.y;
  const c = Math.cos(decal.angle),
    s = Math.sin(decal.angle);
  return Math.abs(c * dx - s * dy) <= decal.w / 2 && Math.abs(s * dx + c * dy) <= decal.h / 2;
}
