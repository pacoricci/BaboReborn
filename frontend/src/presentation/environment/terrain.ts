// Static vertex colour and wear masks keep terrain work out of the frame loop.
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import type { Vec2, Wall } from '../../core/geometry';
import type { Theme } from '../../content/types';
import { FLOOR_LAYERS } from './floor-layers';
export interface TerrainArt {
  readonly paths: readonly (readonly Readonly<Vec2>[])[];
}

export function terrain(
  scene: Scene,
  size: number,
  materials: { terrain: StandardMaterial; earth: StandardMaterial; theme: Theme },
  art?: TerrainArt,
  height = size,
  walls: readonly Wall[] = [],
): void {
  const scenario = materials.theme;
  const floor = MeshBuilder.CreateGround(
    'floor',
    { width: size, height, subdivisions: Math.min(144, Math.ceil(Math.max(size, height) * 4)) },
    scene,
  );
  floor.position.set(size / 2, 0, height / 2);
  floor.material = materials.terrain;
  floor.receiveShadows = true;
  floor.isPickable = false;
  const uv = floor.getVerticesData(VertexBuffer.UVKind)!;
  floor.setVerticesData(
    VertexBuffer.UVKind,
    Array.from(uv, (v, i) => (v * (i % 2 === 0 ? size : height)) / scenario.floorTile),
  );
  // Constructed floors use their authored albedo without outdoor dirt masks.
  if (!scenario.outdoorWear) {
    floor.freezeWorldMatrix();
    return;
  }
  const positions = floor.getVerticesData(VertexBuffer.PositionKind)!;
  const colors: number[] = [],
    wear: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]! + size / 2,
      y = positions[i + 2]! + height / 2;
    // Incommensurate wavelengths break the six-cell tile's broad repeating pattern.
    const variation = Math.sin(x * 0.73 + y * 0.31) * Math.cos(y * 0.59 - x * 0.21) * 0.11;
    // Neutral modulation preserves the scorched palette instead of tinting it lawn green.
    const shade = 0.9 + variation * 0.65;
    colors.push(shade, shade, shade, 1);
    let distance = Infinity;
    for (const path of art?.paths ?? [])
      for (let j = 1; j < path.length; j++) {
        const a = path[j - 1]!,
          b = path[j]!,
          dx = b.x - a.x,
          dy = b.y - a.y;
        const t = Math.max(
          0,
          Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)),
        );
        distance = Math.min(distance, Math.hypot(x - a.x - dx * t, y - a.y - dy * t));
      }
    const edge = distance + Math.sin(x * 3.7 + y * 2.1) * 0.09 + Math.cos(y * 5.3 - x) * 0.06;
    const routeWear = Math.max(0, Math.min(1, (1.1 - edge) / 0.65)) * 0.88;
    // Quiet patches also decorate community maps without authored route metadata.
    const patch = Math.sin(x * 0.81 + Math.sin(y * 0.53)) * Math.cos(y * 0.67 - x * 0.24);
    const patchWear = Math.max(0, (patch - 0.22) / 0.78) * 0.58;
    let wallDistance = Infinity;
    for (const wall of walls) {
      const dx = Math.max(wall.x - x, 0, x - wall.x - wall.w);
      const dy = Math.max(wall.y - y, 0, y - wall.y - wall.h);
      wallDistance = Math.min(wallDistance, Math.hypot(dx, dy));
    }
    const baseWear = Math.max(0, 1 - wallDistance / 0.55) * 0.62;
    const alpha = Math.max(routeWear, patchWear, baseWear);
    const grain = 0.92 + Math.sin(x * 19.3 + y * 31.1) * 0.08;
    wear.push(grain, grain, grain, alpha);
  }
  floor.setVerticesData(VertexBuffer.ColorKind, colors);
  floor.freezeWorldMatrix();
  const paths = floor.clone('terrain-wear');
  paths.makeGeometryUnique();
  paths.unfreezeWorldMatrix();
  paths.position.y = 0.006;
  const dirt = materials.earth;
  const earthUV = paths.getVerticesData(VertexBuffer.UVKind)!;
  paths.setVerticesData(
    VertexBuffer.UVKind,
    Array.from(earthUV, (v) => (v * scenario.floorTile) / 3),
  );
  paths.material = dirt;
  paths.hasVertexAlpha = true;
  paths.alphaIndex = FLOOR_LAYERS.wear;
  paths.setVerticesData(VertexBuffer.ColorKind, wear);
  paths.freezeWorldMatrix();
}
