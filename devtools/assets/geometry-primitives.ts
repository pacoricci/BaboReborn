import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';

type Point = [number, number, number];
type Primitive =
  | { shape: 'box'; size: Point; bevel: number }
  | { shape: 'cylinder'; radius: number; length: number; innerRadius: number };

// Flat faces retain hard edges and explicit UVs on small equipment details.
function geometry(part: Primitive) {
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  function face(
    points: number[][],
    normal: number[],
    tex = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  ) {
    const start = positions.length / 3;
    for (let i = 0; i < points.length; i++) {
      positions.push(...points[i]!);
      normals.push(...normal);
      uvs.push(...tex[i]!);
    }
    for (let i = 1; i < points.length - 1; i++) indices.push(start, start + i, start + i + 1);
  }
  if (part.shape === 'box' && part.bevel) {
    const [x, y, z] = part.size.map((v) => v / 2) as Point,
      c = part.bevel;
    const ring = [
      [-x + c, -y],
      [x - c, -y],
      [x, -y + c],
      [x, y - c],
      [x - c, y],
      [-x + c, y],
      [-x, y - c],
      [-x, -y + c],
    ];
    for (let i = 0; i < 8; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % 8]!;
      const dx = b[0]! - a[0]!,
        dy = b[1]! - a[1]!,
        length = Math.hypot(dx, dy);
      face(
        [
          [...a, -z],
          [...b, -z],
          [...b, z],
          [...a, z],
        ],
        [dy / length, -dx / length, 0],
      );
    }
    face(
      ring.map((p) => [...p, z]),
      [0, 0, 1],
      ring.map(() => [0, 0]),
    );
    face(
      [...ring].reverse().map((p) => [...p, -z]),
      [0, 0, -1],
      ring.map(() => [0, 0]),
    );
  } else if (part.shape === 'box') {
    const [x, y, z] = part.size.map((v) => v / 2) as Point;
    face(
      [
        [x, -y, -z],
        [x, y, -z],
        [x, y, z],
        [x, -y, z],
      ],
      [1, 0, 0],
    );
    face(
      [
        [-x, -y, z],
        [-x, y, z],
        [-x, y, -z],
        [-x, -y, -z],
      ],
      [-1, 0, 0],
    );
    face(
      [
        [-x, y, -z],
        [-x, y, z],
        [x, y, z],
        [x, y, -z],
      ],
      [0, 1, 0],
    );
    face(
      [
        [-x, -y, z],
        [-x, -y, -z],
        [x, -y, -z],
        [x, -y, z],
      ],
      [0, -1, 0],
    );
    face(
      [
        [-x, -y, z],
        [x, -y, z],
        [x, y, z],
        [-x, y, z],
      ],
      [0, 0, 1],
    );
    face(
      [
        [x, -y, -z],
        [-x, -y, -z],
        [-x, y, -z],
        [x, y, -z],
      ],
      [0, 0, -1],
    );
  } else {
    const r = part.radius,
      z = part.length / 2,
      n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i * Math.PI * 2) / n,
        b = ((i + 1) * Math.PI * 2) / n;
      const p = [Math.cos(a) * r, Math.sin(a) * r],
        q = [Math.cos(b) * r, Math.sin(b) * r];
      face(
        [
          [...p, -z],
          [...q, -z],
          [...q, z],
          [...p, z],
        ],
        [Math.cos((a + b) / 2), Math.sin((a + b) / 2), 0],
      );
      if (part.innerRadius) {
        const f = part.innerRadius / r,
          pi = p.map((v) => v * f),
          qi = q.map((v) => v * f);
        face(
          [
            [...pi, z],
            [...qi, z],
            [...qi, -z],
            [...pi, -z],
          ],
          [-Math.cos((a + b) / 2), -Math.sin((a + b) / 2), 0],
        );
        face(
          [
            [...p, z],
            [...q, z],
            [...qi, z],
            [...pi, z],
          ],
          [0, 0, 1],
        );
        face(
          [
            [...q, -z],
            [...p, -z],
            [...pi, -z],
            [...qi, -z],
          ],
          [0, 0, -1],
        );
      } else {
        face(
          [
            [0, 0, z],
            [...p, z],
            [...q, z],
          ],
          [0, 0, 1],
          [
            [0.5, 0.5],
            [0, 0],
            [1, 1],
          ],
        );
        face(
          [
            [0, 0, -z],
            [...q, -z],
            [...p, -z],
          ],
          [0, 0, -1],
          [
            [0.5, 0.5],
            [1, 1],
            [0, 0],
          ],
        );
      }
    }
  }
  return { positions, normals, uvs, indices };
}

function primitive(scene: Scene, name: string, shape: Primitive): Mesh {
  const values = geometry(shape);
  const data = new VertexData();
  // Faces above use outward CCW winding; Babylon authoring uses left-handed coordinates.
  data.positions = values.positions.map((v, i) => (i % 3 === 0 ? -v : v));
  data.normals = values.normals.map((v, i) => (i % 3 === 0 ? -v : v));
  data.uvs = values.uvs;
  data.indices = values.indices;
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh);
  return mesh;
}

export function createBox(scene: Scene, name: string, size: Point, bevel = 0): Mesh {
  return primitive(scene, name, { shape: 'box', size, bevel });
}

export function createCylinder(
  scene: Scene,
  name: string,
  radius: number,
  length: number,
  innerRadius = 0,
): Mesh {
  return primitive(scene, name, { shape: 'cylinder', radius, length, innerRadius });
}
