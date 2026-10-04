import type { Vec2, Wall } from '../core/geometry';
export type MapTheme = string;
export function isMapTheme(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value);
}
export interface MapDecal extends Readonly<Vec2> {
  readonly asset: string;
  readonly w: number;
  readonly h: number;
  readonly angle: number; // [radians]
  readonly opacity: number;
}
export interface MapWall extends Wall {
  readonly material?: string;
}
interface TeamBase {
  readonly base: Readonly<Vec2>;
  readonly spawns: readonly Readonly<Vec2>[];
}
export interface ArenaMap {
  readonly theme: MapTheme;
  readonly teams?: { readonly blue: TeamBase; readonly red: TeamBase };
  readonly name: string;
  readonly schema: 1;
  readonly decals?: readonly MapDecal[];
  readonly id: string;
  readonly author: string;
  readonly width: number;
  readonly height: number;
  readonly walls: readonly MapWall[];
  readonly spawns: readonly Readonly<Vec2>[];
}

// Project authored walls once at world creation, keeping cosmetics out of core state.
export function geometryWalls(arena: ArenaMap): Wall[] {
  return arena.walls.map(({ x, y, w, h, height }) => ({
    x,
    y,
    w,
    h,
    ...(height === undefined ? {} : { height }),
  }));
}
