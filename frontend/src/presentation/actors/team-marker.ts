import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { teamSymbol } from './team-style';
import type { TeamStyle } from './team-style';

// Flat, opaque ground ink avoids translucent sorting and keeps the actor silhouette open.
export function createTeamMarker(
  scene: Scene,
  material: (name: string, hex: string, glow?: number) => StandardMaterial,
) {
  const make = (name: string, polygons: number[][], mat: StandardMaterial) => {
    const positions: number[] = [],
      indices: number[] = [];
    for (const polygon of polygons) {
      const first = positions.length / 3;
      positions.push(...polygon);
      for (let i = 1; i < polygon.length / 3 - 1; i++)
        indices.push(first, first + i, first + i + 1);
    }
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = positions.map((_, i) => (i % 3 === 1 ? 1 : 0));
    const mesh = new Mesh(name, scene);
    data.applyToMesh(mesh);
    mesh.material = mat;
    mesh.isPickable = false;
    return mesh;
  };
  const arcs = (inner: number, outer: number, height: number) => {
    const polygons: number[][] = [];
    for (let quadrant = 0; quadrant < 4; quadrant++)
      for (let step = 0; step < 12; step++) {
        const a = (quadrant * Math.PI) / 2 + 0.14 + (step * (Math.PI / 2 - 0.28)) / 12;
        const b = a + (Math.PI / 2 - 0.28) / 12;
        polygons.push([
          Math.cos(a) * inner,
          height,
          Math.sin(a) * inner,
          Math.cos(a) * outer,
          height,
          Math.sin(a) * outer,
          Math.cos(b) * outer,
          height,
          Math.sin(b) * outer,
          Math.cos(b) * inner,
          height,
          Math.sin(b) * inner,
        ]);
      }
    return polygons;
  };
  const ring = make(
    'team-color',
    arcs(0.307, 0.357, 0.003),
    material('team-color', '#ffffff', 0.35),
  );
  const border = make(
    'team-keyline',
    arcs(0.29, 0.375, 0),
    material('team-keyline', '#142129', 0.1),
  );
  border.parent = ring;
  const ivory = material('team-insignia', '#f3ead5', 0.3);
  const symbols = (['blue', 'red'] as const).map((team: TeamStyle) => {
    // Badge sits beside the body, away from the rear health bar and weapon muzzle.
    const polygons = teamSymbol(team).map((polygon) =>
      polygon.flatMap(([x, z]) => [x * 0.09 - 0.43, 0.006, z * 0.09]),
    );
    const symbol = make(`team-${team}-insignia`, polygons, ivory);
    symbol.parent = ring;
    symbol.setEnabled(false);
    return symbol;
  });
  return { ring, blue: symbols[0]!, red: symbols[1]! };
}
