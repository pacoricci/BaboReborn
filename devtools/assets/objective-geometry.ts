import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TEAM_COLORS, teamSymbol } from '../../frontend/src/presentation/actors/team-style';

// Authored, static geometry. Compact, upright cloth leaves the ground visible;
// folds are baked at build time, with no cloth simulation or per-frame allocations.
export function createObjectiveGeometry(
  scene: Scene,
  kind: string,
  material: (name: string, hex: string, glow?: number) => StandardMaterial,
): TransformNode {
  const team = kind.endsWith('blue') ? 'blue' : 'red';
  const root = new TransformNode(kind, scene);
  const dark = material('objective-carbon', '#202c34');
  const steel = material('objective-steel', '#899ca7');
  const paint = material(`objective-${team}`, TEAM_COLORS[team], 0.08);
  const inset = material(`objective-${team}-inset`, team === 'blue' ? '#1b4973' : '#702c31');
  const light = material('objective-ivory', '#f3ead5', 0.12);
  const glow = material(`objective-${team}-light`, TEAM_COLORS[team], 0.45);
  const attach = (mesh: Mesh, mat: StandardMaterial, x = 0, y = 0, z = 0) => {
    mesh.parent = root;
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.isPickable = false;
    return mesh;
  };
  const cylinder = (
    name: string,
    diameter: number,
    height: number,
    y: number,
    mat: StandardMaterial,
    top = diameter,
    sides = 12,
  ) =>
    attach(
      MeshBuilder.CreateCylinder(
        name,
        { diameterBottom: diameter, diameterTop: top, height, tessellation: sides },
        scene,
      ),
      mat,
      0,
      y,
    );
  const box = (
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    mat: StandardMaterial,
  ) => attach(MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene), mat, x, y, z);
  const surface = (
    name: string,
    points: readonly (readonly [number, number])[],
    map: (u: number, v: number) => number[],
    mat: StandardMaterial,
    subdivisions = 1,
  ) => {
    const positions: number[] = [],
      indices: number[] = [],
      uvs: number[] = [];
    // Subdivide insignia in cloth coordinates so the embroidery follows every fold.
    for (let face = 1; face < points.length - 1; face++) {
      const a = points[0]!,
        b = points[face]!,
        c = points[face + 1]!;
      const vertex = (i: number, j: number) => {
        const u = a[0] + ((b[0] - a[0]) * i) / subdivisions + ((c[0] - a[0]) * j) / subdivisions;
        const v = a[1] + ((b[1] - a[1]) * i) / subdivisions + ((c[1] - a[1]) * j) / subdivisions;
        positions.push(...map(u, v));
        uvs.push(u, v);
        return positions.length / 3 - 1;
      };
      for (let i = 0; i < subdivisions; i++)
        for (let j = 0; j < subdivisions - i; j++) {
          indices.push(vertex(i, j), vertex(i + 1, j), vertex(i, j + 1));
          if (i + j < subdivisions - 1)
            indices.push(vertex(i + 1, j), vertex(i + 1, j + 1), vertex(i, j + 1));
        }
    }
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.uvs = uvs;
    const mesh = new Mesh(name, scene);
    data.applyToMesh(mesh);
    return attach(mesh, mat);
  };
  if (kind.startsWith('base-')) {
    cylinder('base-foot', 1.3, 0.055, 0.005, dark);
    cylinder('beveled-plinth', 1.28, 0.065, 0.055, steel, 1.15);
    cylinder('team-deck', 1.14, 0.025, 0.1, paint);
    cylinder('recessed-deck', 0.93, 0.015, 0.115, dark);
    cylinder('inset-medallion', 0.79, 0.012, 0.126, inset);
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const x = Math.sin(angle),
        z = Math.cos(angle);
      const lug = box('radial-clamp', x * 0.53, 0.13, z * 0.53, 0.105, 0.065, 0.2, dark);
      lug.rotation.y = angle;
      const lens = box('recessed-light', x * 0.56, 0.168, z * 0.56, 0.057, 0.008, 0.072, glow);
      lens.rotation.y = angle;
      const bolt = cylinder('deck-fastener', 0.032, 0.008, 0.134, steel, 0.032, 6);
      bolt.position.x = x * 0.425;
      bolt.position.z = z * 0.425;
    }
    for (const polygon of teamSymbol(team))
      surface('base-insignia', polygon, (u, v) => [u * 0.25, 0.135, v * 0.25], light);
  } else {
    cylinder('pole-shoe', 0.17, 0.05, 0.025, dark);
    cylinder('pole-socket', 0.1, 0.1, 0.09, steel, 0.065);
    cylinder('pole', 0.038, 0.9, 0.55, steel);
    cylinder('pole-grip', 0.057, 0.22, 0.27, dark);
    for (const y of [0.18, 0.36, 0.74, 0.94]) cylinder('pole-collar', 0.071, 0.024, y, light);
    cylinder('finial', 0.095, 0.095, 1.025, paint, 0, 8);
    // Keep a slight slope for overhead recognition without spreading across the ground.
    const cloth = (u: number, v: number, lift = 0): [number, number, number] => {
      const length = 0.46 - 0.09 * (1 - Math.abs(v * 2 - 1));
      const x = 0.025 + u * length;
      return [
        x,
        0.93 - v * 0.32 + Math.sin(u * Math.PI * 3 - v * 0.8) * 0.025 * u + lift,
        (v - 0.5) * 0.16 + Math.sin(u * Math.PI * 2) * 0.02 * u,
      ];
    };
    for (let u = 0; u < 16; u++)
      for (let v = 0; v < 8; v++) {
        const points: [number, number][] = [
          [u / 16, v / 8],
          [(u + 1) / 16, v / 8],
          [(u + 1) / 16, (v + 1) / 8],
          [u / 16, (v + 1) / 8],
        ];
        const mat = v === 0 || v === 7 || u === 15 ? light : u < 2 ? inset : paint;
        surface('cloth-face', points, (a, b) => cloth(a, b), mat);
        // Explicit underside survives GLB culling without changing material contracts.
        surface('cloth-back', [...points].reverse(), (a, b) => cloth(a, b, -0.004), mat);
      }
    for (const polygon of teamSymbol(team)) {
      surface(
        'woven-insignia',
        polygon,
        (u, v) => cloth(0.51 + u * 0.17, 0.48 + v * 0.23, 0.006),
        light,
        6,
      );
      surface(
        'woven-insignia-back',
        [...polygon].reverse(),
        (u, v) => cloth(0.51 + u * 0.17, 0.48 + v * 0.23, -0.01),
        light,
        6,
      );
    }
    for (const v of [0.1, 0.9]) {
      const [x, y, z] = cloth(0, v);
      box('cloth-clasp', x, y, z, 0.07, 0.033, 0.035, dark);
    }
  }
  // Collapse static pieces by material before export: detail does not mean a draw per bolt/fold.
  for (const mat of [dark, steel, paint, inset, light, glow]) {
    const meshes = root.getChildMeshes().filter((mesh) => mesh.material === mat) as Mesh[];
    if (!meshes.length) continue;
    const merged = Mesh.MergeMeshes(meshes, true, true)!;
    merged.name = mat.name;
    merged.parent = root;
    merged.isPickable = false;
  }
  return root;
}
