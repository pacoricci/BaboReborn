// Static material groups preserve the authored wall silhouette and collision dimensions.
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial';
import type { Wall } from '../../core/geometry';

export function wallSurface(mesh: Mesh, wall: Wall, materials: MultiMaterial, tile = 2): void {
  const height = wall.height ?? 0.7;
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
  const indices = mesh.getIndices()!;
  const uv: number[] = [],
    colors: number[] = [];
  const sides: number[] = [],
    tops: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]! * wall.w + wall.x + wall.w / 2;
    const y = (positions[i + 1]! + 0.5) * height;
    const z = positions[i + 2]! * wall.h + wall.y + wall.h / 2;
    const top = normals[i + 1]! > 0.5;
    // World-aligned two-cell tiles keep joints continuous across neighboring walls.
    uv.push((Math.abs(normals[i]!) > 0.5 ? z : x) / tile, (top ? z : y) / tile);
    const weather = Math.sin(x * 1.37 + z * 0.83) * 0.025;
    const shade = top ? 0.96 + weather : 0.7 + Math.min(1, y / height) * 0.23 + weather;
    colors.push(shade, shade + (top ? 0 : 0.015), shade - 0.025, 1);
  }
  for (let i = 0; i < indices.length; i += 3) {
    const target = normals[indices[i]! * 3 + 1]! > 0.5 ? tops : sides;
    target.push(indices[i]!, indices[i + 1]!, indices[i + 2]!);
  }
  mesh.makeGeometryUnique();
  mesh.setVerticesData(VertexBuffer.UVKind, uv);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.setIndices([...sides, ...tops]);
  mesh.material = materials;
  mesh.isPickable = false;
  mesh.releaseSubMeshes();
  if (sides.length) new SubMesh(0, 0, positions.length / 3, 0, sides.length, mesh);
  if (tops.length) new SubMesh(1, 0, positions.length / 3, sides.length, tops.length, mesh);
}
