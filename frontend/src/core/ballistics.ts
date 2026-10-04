import { clamp } from './geometry';
import type { Vec3, Wall } from './geometry';

// A finite segment, rather than an infinite ray. Source: Map::rayTileTest.
// Tests cover faces, wall tops, floor, blocked muzzle and target projections.
export function mapImpact(from: Vec3, to: Vec3, walls: readonly Wall[], height: number) {
  let fraction = 1;
  let normal: Vec3 | null = null;
  const dx = to.x - from.x,
    dy = to.y - from.y,
    dz = to.z - from.z;
  if (from.z > 0 && to.z <= 0) {
    fraction = -from.z / dz;
    normal = { x: 0, y: 0, z: 1 };
  }
  for (const wall of walls) {
    const wallHeight = wall.height ?? height;
    if (
      from.x >= wall.x &&
      from.x < wall.x + wall.w &&
      from.y >= wall.y &&
      from.y < wall.y + wall.h &&
      from.z < wallHeight
    ) {
      return { point: { ...from }, normal: { x: 0, y: 0, z: 0 } };
    }
    // Top, then the four entry faces; only the nearest valid intersection remains.
    for (let face = 0; face < 5; face++) {
      let t: number;
      if (face === 0) {
        if (from.z <= wallHeight || to.z > wallHeight) continue;
        t = (wallHeight - from.z) / dz;
      } else if (face <= 2) {
        const edge = face === 1 ? wall.x : wall.x + wall.w;
        if (face === 1 ? !(from.x <= edge && to.x > edge) : !(from.x >= edge && to.x < edge))
          continue;
        t = (edge - from.x) / dx;
      } else {
        const edge = face === 3 ? wall.y : wall.y + wall.h;
        if (face === 3 ? !(from.y <= edge && to.y > edge) : !(from.y >= edge && to.y < edge))
          continue;
        t = (edge - from.y) / dy;
      }
      if (t < 0 || t > fraction) continue;
      const x = from.x + dx * t,
        y = from.y + dy * t,
        z = from.z + dz * t;
      if (
        x < wall.x - 1e-10 ||
        x > wall.x + wall.w + 1e-10 ||
        y < wall.y - 1e-10 ||
        y > wall.y + wall.h + 1e-10 ||
        (face !== 0 && z >= wallHeight)
      )
        continue;
      fraction = t;
      normal = {
        x: face === 1 ? -1 : face === 2 ? 1 : 0,
        y: face === 3 ? -1 : face === 4 ? 1 : 0,
        z: face === 0 ? 1 : 0,
      };
    }
  }
  return {
    point: { x: from.x + dx * fraction, y: from.y + dy * fraction, z: from.z + dz * fraction },
    normal,
  };
}

// The original segmentToSphere returns the closest point ON the segment, not
// the entry point on the sphere. The caller shortens its segment after each hit.
export function sphereImpact(from: Vec3, to: Vec3, center: Vec3, radius: number): Vec3 | null {
  const dx = to.x - from.x,
    dy = to.y - from.y,
    dz = to.z - from.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) return null;
  const t = clamp(
    ((center.x - from.x) * dx + (center.y - from.y) * dy + (center.z - from.z) * dz) /
      lengthSquared,
    0,
    1,
  );
  const point = { x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t };
  return (point.x - center.x) ** 2 + (point.y - center.y) ** 2 + (point.z - center.z) ** 2 <=
    radius * radius
    ? point
    : null;
}
