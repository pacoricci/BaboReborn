export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 extends Vec2 {
  z: number;
}
export interface Wall {
  readonly height?: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface MovingBody extends Vec2 {
  vx: number;
  vy: number;
}
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function rayWall(origin: Vec2, direction: Vec2, wall: Wall): number {
  let near = 0,
    far = Infinity;
  for (const [p, d, low, high] of [
    [origin.x, direction.x, wall.x, wall.x + wall.w],
    [origin.y, direction.y, wall.y, wall.y + wall.h],
  ] as const) {
    if (Math.abs(d) < 1e-10) {
      if (p < low || p > high) return Infinity;
    } else {
      const a = (low - p) / d,
        b = (high - p) / d;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return Infinity;
    }
  }
  return near;
}
