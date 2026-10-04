import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';

type Point = [number, number, number];
type Profile = [radius: number, height: number][];

// Cosmetic recipes share the existing GLB pipeline and keep each deployment pivot intact.
export function createSecondaryGeometry(
  scene: Scene,
  kind: 'knives' | 'grenade' | 'molotov',
  material: (name: string, hex: string) => StandardMaterial,
): TransformNode {
  const root = new TransformNode(kind, scene);
  const steel = material('secondary-steel', '#95a8ad');
  const dark = material('secondary-carbon', '#28383d');
  let owner = root;
  const groups = new Map<TransformNode, Map<StandardMaterial, Mesh[]>>();
  const add = (mesh: Mesh, mat: StandardMaterial, at: Point = [0, 0, 0]) => {
    mesh.position.set(...at);
    mesh.material = mat;
    mesh.isPickable = false;
    const materials = groups.get(owner) ?? new Map<StandardMaterial, Mesh[]>();
    const meshes = materials.get(mat) ?? [];
    meshes.push(mesh);
    materials.set(mat, meshes);
    groups.set(owner, materials);
    return mesh;
  };
  const box = (at: Point, size: Point, mat: StandardMaterial) =>
    add(
      MeshBuilder.CreateBox(kind, { width: size[0], height: size[1], depth: size[2] }, scene),
      mat,
      at,
    );
  const lathe = (profile: Profile, mat: StandardMaterial, tessellation = 16) =>
    add(
      MeshBuilder.CreateLathe(
        kind,
        { shape: profile.map(([r, y]) => new Vector3(r, y, 0)), tessellation },
        scene,
      ),
      mat,
    );
  const surface = (faces: Point[][], mat: StandardMaterial) => {
    const positions: number[] = [],
      indices: number[] = [],
      uvs: number[] = [];
    for (const face of faces) {
      const start = positions.length / 3;
      for (const p of face) {
        positions.push(...p);
        uvs.push(p[0] * 4, p[2] * 4);
      }
      for (let i = 1; i < face.length - 1; i++) indices.push(start, start + i, start + i + 1);
    }
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const data = new VertexData();
    Object.assign(data, { positions, indices, normals, uvs });
    const mesh = new Mesh(kind, scene);
    data.applyToMesh(mesh);
    return add(mesh, mat);
  };
  const pipe = (path: Point[], radius: number, mat: StandardMaterial) =>
    add(
      MeshBuilder.CreateTube(
        kind,
        {
          path: path.map((p) => new Vector3(...p)),
          radius,
          tessellation: 8,
          cap: Mesh.CAP_ALL,
        },
        scene,
      ),
      mat,
    );

  if (kind === 'grenade') {
    const shell = material('grenade-olive', '#85934e');
    const brass = material('grenade-brass', '#bbaa6b');
    const profile: Profile = [
      [0, -0.073],
      [0.049, -0.073],
      [0.078, -0.053],
      [0.097, -0.013],
      [0.1, 0.04],
      [0.088, 0.09],
      [0.06, 0.129],
      [0, 0.129],
    ];
    lathe(profile, dark, 20);
    // Raised shell blocks leave real recessed channels readable in an overhead view.
    for (let row = 1; row < profile.length - 2; row++) {
      const [r0, y0] = profile[row]!,
        [r1, y1] = profile[row + 1]!;
      for (let column = 0; column < 10; column++) {
        const a = (column * Math.PI) / 5 + 0.032,
          b = ((column + 1) * Math.PI) / 5 - 0.032;
        const point = (r: number, y: number, angle: number): Point => [
          Math.sin(angle) * r,
          y,
          Math.cos(angle) * r,
        ];
        const outer = [
          point(r0 + 0.006, y0 + 0.003, a),
          point(r0 + 0.006, y0 + 0.003, b),
          point(r1 + 0.006, y1 - 0.003, b),
          point(r1 + 0.006, y1 - 0.003, a),
        ];
        const inset = outer.map(([x, y, z]): Point => [x * 0.91, y, z * 0.91]);
        surface(
          [
            outer,
            ...outer.map((p, i) => [p, inset[i]!, inset[(i + 1) % 4]!, outer[(i + 1) % 4]!]),
          ].map((face) => face.reverse()),
          shell,
        );
      }
    }
    lathe(
      [
        [0, 0.128],
        [0.043, 0.128],
        [0.043, 0.142],
        [0.032, 0.147],
        [0.032, 0.17],
        [0, 0.17],
      ],
      brass,
      12,
    );
    box([0, 0.177, 0.011], [0.044, 0.016, 0.106], steel);
    const lever = box([0, 0.103, 0.098], [0.044, 0.164, 0.014], steel);
    lever.rotation.x = -0.32;
    const pin = pipe(
      [
        [-0.057, 0.159, -0.019],
        [0.047, 0.159, -0.019],
      ],
      0.007,
      steel,
    );
    pin.name = 'grenade-safety-pin';
    const ring = add(
      MeshBuilder.CreateTorus(
        'grenade-pull-ring',
        {
          diameter: 0.085,
          thickness: 0.012,
          tessellation: 20,
        },
        scene,
      ),
      steel,
      [-0.072, 0.183, 0.069],
    );
    // The ring lies in the same plane as the bottle/grenade silhouette after posing.
    ring.rotation.x = Math.PI / 2;
  } else if (kind === 'molotov') {
    const glass = material('bottle-green', '#487241');
    const rim = material('bottle-rim', '#638052');
    const paper = material('bottle-label', '#d3bc85');
    const ink = material('bottle-ink', '#974f35');
    const cloth = material('bottle-wick', '#ded5b8');
    // Opaque coloured glass avoids transparency sorting across many small flying instances.
    lathe(
      [
        [0, -0.074],
        [0.048, -0.074],
        [0.069, -0.066],
        [0.078, -0.047],
        [0.078, 0.096],
        [0.074, 0.12],
        [0.064, 0.142],
        [0.038, 0.164],
        [0.027, 0.184],
        [0.027, 0.24],
        [0.033, 0.243],
        [0.033, 0.257],
        [0.023, 0.26],
        [0.021, 0.246],
        [0, 0.246],
      ],
      glass,
      20,
    );
    lathe(
      [
        [0.072, -0.06],
        [0.08, -0.051],
        [0.08, -0.036],
        [0.078, -0.029],
      ],
      rim,
      20,
    );
    lathe(
      [
        [0.027, 0.224],
        [0.03, 0.225],
        [0.03, 0.234],
        [0.027, 0.236],
      ],
      rim,
      20,
    );
    lathe(
      [
        [0.079, -0.005],
        [0.08, 0],
        [0.08, 0.083],
        [0.079, 0.088],
      ],
      paper,
      20,
    );
    for (const y of [0.009, 0.071])
      lathe(
        [
          [0.0805, y],
          [0.0805, y + 0.007],
        ],
        ink,
        20,
      );
    // The broad emblem remains legible without text or a separate texture dependency.
    for (const side of [-1, 1]) {
      const emblem = box([0, 0.043, side * 0.081], [0.026, 0.026, 0.0015], ink);
      emblem.rotation.z = Math.PI / 4;
    }
    lathe(
      [
        [0, 0.254],
        [0.022, 0.254],
        [0.024, 0.266],
        [0.018, 0.277],
        [0, 0.277],
      ],
      cloth,
      10,
    );
    // A closed folded ribbon gives the wick a cloth silhouette from both sides.
    const folds: Point[] = [
      [0, 0.267, 0],
      [0.022, 0.293, 0.003],
      [0.052, 0.3, 0.008],
      [0.079, 0.285, 0.012],
      [0.106, 0.292, 0.019],
    ];
    for (let i = 0; i < folds.length - 1; i++) {
      const a = folds[i]!,
        b = folds[i + 1]!;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const dx = (-(b[1] - a[1]) / length) * 0.016;
      const dy = ((b[0] - a[0]) / length) * 0.016;
      // Width follows the silhouette plane; thickness becomes height in the overhead pose.
      const corners = (p: Point): Point[] => [
        [p[0] - dx, p[1] - dy, p[2] + 0.003],
        [p[0] + dx, p[1] + dy, p[2] + 0.003],
        [p[0] + dx, p[1] + dy, p[2] - 0.003],
        [p[0] - dx, p[1] - dy, p[2] - 0.003],
      ];
      const left = corners(a),
        right = corners(b);
      surface(
        [
          [...left].reverse(),
          right,
          ...left.map((p, j) => [p, left[(j + 1) % 4]!, right[(j + 1) % 4]!, right[j]!]),
        ].map((face) => face.reverse()),
        i === 3 ? dark : cloth,
      );
    }
  } else {
    const face = material('blade-steel', '#93a8b1');
    const edge = material('blade-edge-steel', '#e3ebed');
    // A shallow spiral controls the sweep; the smaller sine wave gives both edges
    // a flowing profile. Radius and deployment pivots retain the existing reach.
    const centerline = (t: number) => {
      const radius = 0.245 + 0.595 * t;
      const sweep = 0.34 * t * t;
      return {
        x: -radius * Math.sin(sweep) + 0.035 * Math.sin(5 * Math.PI * t) * Math.sin(Math.PI * t),
        z: radius * Math.cos(sweep) - 0.18,
      };
    };
    const sections = Array.from({ length: 33 }, (_, i) => {
      const t = i / 32,
        center = centerline(t);
      const before = centerline(Math.max(0, t - 0.001));
      const after = centerline(Math.min(1, t + 0.001));
      const dx = after.x - before.x,
        dz = after.z - before.z;
      const length = Math.hypot(dx, dz);
      const width = 0.047 * (1 - Math.pow(t, 2.5)) + 0.0007;
      const height = 0.019 * Math.sin(Math.PI * (0.15 + 0.85 * t)) + 0.001;
      const point = (across: number, y: number): Point => [
        center.x + (dz / length) * width * across,
        y,
        center.z - (dx / length) * width * across,
      ];
      return [
        point(-1, 0),
        point(-0.64, height * 0.6),
        point(0, height),
        point(0.64, height * 0.6),
        point(1, 0),
        point(0.64, -height * 0.6),
        point(0, -height),
        point(-0.64, -height * 0.6),
      ];
    });
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      owner = new TransformNode(`blade-${i}`, scene);
      owner.parent = root;
      owner.position.set(Math.sin(angle) * 0.18, 0.25, Math.cos(angle) * 0.18);
      box([0, 0, 0.047], [0.092, 0.051, 0.118], dark);
      box([0, 0, 0.105], [0.111, 0.043, 0.025], steel);
      for (const z of [0.018, 0.055]) box([0, 0.027, z], [0.066, 0.007, 0.01], steel);
      const rings = sections;
      for (let j = 0; j < 8; j++) {
        const faces = rings
          .slice(0, -1)
          .map((ring, k) => [
            ring[j]!,
            ring[(j + 1) % 8]!,
            rings[k + 1]![(j + 1) % 8]!,
            rings[k + 1]![j]!,
          ]);
        surface(faces, [0, 3, 4, 7].includes(j) ? edge : face);
      }
      surface([[...rings[0]!].reverse(), rings.at(-1)!], face);
      for (const meshes of groups.get(owner)!.values())
        for (const mesh of meshes) {
          // Rotate details around the local deployment origin before batching.
          const { x, z } = mesh.position;
          mesh.position.x = x * Math.cos(angle) + z * Math.sin(angle);
          mesh.position.z = z * Math.cos(angle) - x * Math.sin(angle);
          mesh.rotation.y = angle;
        }
    }
  }
  // Batch disconnected details by finish within each moving part, not per shell block.
  for (const [part, materials] of groups)
    for (const [mat, meshes] of materials) {
      const merged = Mesh.MergeMeshes(meshes, true, true)!;
      if (kind !== 'knives') {
        // Author the resting/flight silhouette into the GLB so the workshop and game
        // share the same overhead pose. World yaw still follows projectile direction.
        const size = kind === 'molotov' ? 1.12 : 1.15;
        const center = kind === 'molotov' ? 0.108 : 0.065;
        merged.bakeTransformIntoVertices(
          Matrix.RotationX(-Math.PI / 2)
            .multiply(Matrix.Scaling(size, 1, size))
            .multiply(Matrix.Translation(0, 0.035, center * size)),
        );
      }
      merged.name = `${kind}-${mat.name}`;
      merged.material = mat;
      merged.parent = part;
      merged.isPickable = false;
    }
  return root;
}
