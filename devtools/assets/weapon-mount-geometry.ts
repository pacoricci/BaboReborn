import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { ARSENAL_COLORS, PRIMARY_MODELS } from '../../frontend/src/presentation/actors/arsenal';
import type { Scene } from '@babylonjs/core/scene';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';

// A fitted equipment cradle in the aim frame; the skin rolls freely underneath it.
export function createWeaponMount(
  scene: Scene,
  material: (name: string, hex: string) => StandardMaterial,
): TransformNode {
  const root = new TransformNode('weapon-mount', scene);
  const carbon = material('mount-carbon', '#26343b');
  const steel = material('mount-steel', '#73878c');
  const patch = (
    owner: TransformNode,
    radius: number,
    polarStart: number,
    polarEnd: number,
    start: number,
    end: number,
    mat: StandardMaterial,
  ) => {
    const positions: number[] = [],
      indices: number[] = [];
    // Closed spherical patches have thickness and stay clear of the faceted body.
    const rows = 4,
      columns = Math.max(8, Math.ceil((end - start) / 0.18)),
      layer = (rows + 1) * (columns + 1);
    for (const r of [radius, radius - 0.012])
      for (let j = 0; j <= rows; j++) {
        const phi = polarStart + ((polarEnd - polarStart) * j) / rows;
        for (let i = 0; i <= columns; i++) {
          const theta = start + ((end - start) * i) / columns;
          positions.push(
            r * Math.sin(phi) * Math.cos(theta),
            0.25 + r * Math.cos(phi),
            r * Math.sin(phi) * Math.sin(theta),
          );
        }
      }
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < columns; i++) {
        const a = j * (columns + 1) + i,
          b = a + columns + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
        indices.push(a + layer, b + layer, a + 1 + layer, a + 1 + layer, b + layer, b + 1 + layer);
      }
    const edge: number[] = [];
    for (let i = 0; i <= columns; i++) edge.push(i);
    for (let j = 1; j <= rows; j++) edge.push(j * (columns + 1) + columns);
    for (let i = columns - 1; i >= 0; i--) edge.push(rows * (columns + 1) + i);
    for (let j = rows - 1; j > 0; j--) edge.push(j * (columns + 1));
    for (let i = 0; i < edge.length; i++) {
      const a = edge[i]!,
        b = edge[(i + 1) % edge.length]!;
      indices.push(a, a + layer, b, b, a + layer, b + layer);
    }
    // Babylon uses clockwise front faces; keep the shell normals facing away from the body.
    for (let i = 0; i < indices.length; i += 3)
      [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
    const data = new VertexData(),
      normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    const mesh = new Mesh('fitted-shell', scene);
    data.applyToMesh(mesh);
    mesh.parent = owner;
    mesh.material = mat;
    mesh.isPickable = false;
  };
  const box = (owner: TransformNode, at: number[], size: number[], mat = steel) => {
    const mesh = MeshBuilder.CreateBox(
      'mount-bracket',
      {
        width: size[0]!,
        height: size[1]!,
        depth: size[2]!,
      },
      scene,
    );
    mesh.position.copyFromFloats(at[0]!, at[1]!, at[2]!);
    mesh.parent = owner;
    mesh.material = mat;
    mesh.isPickable = false;
    return mesh;
  };
  const pipe = (owner: TransformNode, points: number[][], radius: number, mat = carbon) => {
    const mesh = MeshBuilder.CreateTube(
      'mount-feed',
      {
        path: points.map((p) => Vector3.FromArray(p)),
        radius,
        tessellation: 8,
        cap: Mesh.CAP_ALL,
      },
      scene,
    );
    mesh.parent = owner;
    mesh.material = mat;
    mesh.isPickable = false;
  };
  const collar = (owner: TransformNode, at: number[], diameter: number, mat = steel) => {
    const mesh = MeshBuilder.CreateTorus(
      'mount-collar',
      {
        diameter,
        thickness: 0.018,
        tessellation: 20,
      },
      scene,
    );
    mesh.rotation.x = Math.PI / 2;
    mesh.position.copyFromFloats(at[0]!, at[1]!, at[2]!);
    mesh.parent = owner;
    mesh.material = mat;
    mesh.isPickable = false;
  };
  for (const kind of PRIMARY_MODELS) {
    const part = new TransformNode(kind, scene);
    part.parent = root;
    const accent = material(`mount-${kind}`, ARSENAL_COLORS[kind] ?? '#a1b9ac');
    if (kind === 'smg') {
      // A compact clip supports the short receiver without a full-body harness.
      patch(part, 0.264, 1.02, 1.65, -0.35, 0.78, carbon);
      patch(part, 0.271, 1.15, 1.45, -0.24, 0.63, accent);
      pipe(
        part,
        [
          [0.24, 0.31, 0.08],
          [0.23, 0.32, 0.18],
          [0.165, 0.28, 0.22],
        ],
        0.018,
        steel,
      );
    } else if (kind === 'shotgun') {
      // A broad shoulder sling spreads recoil while leaving the barrel exposed.
      patch(part, 0.261, 0.67, 0.9, -2.8, 0.9, carbon);
      patch(part, 0.266, 0.95, 1.6, -1.18, -0.35, accent);
      box(part, [0.095, 0.405, -0.17], [0.125, 0.06, 0.12], carbon);
      for (let i = 0; i < 4; i++) {
        const x = -0.145 + i * 0.052;
        pipe(
          part,
          [
            [x, 0.455, -0.12],
            [x, 0.47, -0.18],
          ],
          0.017,
          accent,
        );
        pipe(
          part,
          [
            [x, 0.47, -0.18],
            [x, 0.474, -0.196],
          ],
          0.018,
          steel,
        );
      }
    } else if (kind === 'dual') {
      // A rear yoke balances two receivers; each socket stays independent at the front.
      patch(part, 0.262, 1.13, 1.46, -Math.PI, 0, carbon);
      for (const angle of [0, Math.PI]) {
        patch(part, 0.268, 0.88, 1.66, angle - 0.66, angle + 0.66, accent);
        patch(part, 0.276, 1.03, 1.21, angle - 0.52, angle + 0.52, steel);
      }
    } else if (kind === 'chain') {
      // The heavy gun rests in an under-slung frame braced across the back.
      patch(part, 0.269, 1.06, 1.78, -Math.PI, 0.38, carbon);
      patch(part, 0.277, 1.2, 1.5, -2.85, -0.18, accent);
      for (const z of [-0.15, 0.065]) {
        pipe(
          part,
          [
            [0.09, 0.23, z],
            [0.24, 0.17, z],
            [0.37, 0.19, z],
            [0.39, 0.25, z],
          ],
          0.029,
          steel,
        );
      }
      // Support the actual side drum, rather than adding a second decorative magazine.
      pipe(
        part,
        [
          [0.28, 0.19, -0.11],
          [0.47, 0.15, -0.11],
          [0.5, 0.22, -0.11],
        ],
        0.024,
        carbon,
      );
      box(part, [-0.02, 0.36, -0.235], [0.17, 0.1, 0.045], accent);
    } else if (kind === 'sniper') {
      // Two separated contact pads and a narrow spine stabilize the long receiver.
      for (const theta of [-0.72, 0.85])
        patch(part, 0.267, 0.72, 1.34, theta - 0.19, theta + 0.19, carbon);
      pipe(
        part,
        [
          [0.15, 0.425, -0.2],
          [0.18, 0.445, -0.08],
          [0.18, 0.445, 0.09],
          [0.13, 0.38, 0.25],
        ],
        0.015,
        accent,
      );
      box(part, [0.12, 0.3, 0.255], [0.095, 0.08, 0.045], steel);
      box(part, [0.14, 0.37, -0.2], [0.075, 0.06, 0.085], carbon);
    } else if (kind === 'bazooka') {
      // A high shoulder saddle seats the launch tube; two collars secure its axis.
      patch(part, 0.266, 0.36, 1.05, -0.9, 0.78, carbon);
      patch(part, 0.273, 0.68, 1.26, -1.1, -0.6, accent);
      for (const z of [-0.12, 0.1]) {
        collar(part, [0.1758, 0.4197, z], 0.249, carbon);
        box(part, [0.2, 0.325, z], [0.12, 0.055, 0.042], steel);
      }
    } else if (kind === 'photon') {
      // A dorsal power cell feeds the weapon through insulated conduits.
      patch(part, 0.264, 0.52, 1.17, -2.45, -0.85, carbon);
      box(part, [-0.06, 0.47, -0.16], [0.2, 0.1, 0.17], steel);
      for (const x of [-0.12, -0.06, 0]) box(part, [x, 0.526, -0.16], [0.022, 0.013, 0.13], accent);
      for (const z of [-0.2, -0.1])
        pipe(
          part,
          [
            [0.04, 0.48, z],
            [0.17, 0.43, z - 0.035],
            [0.26, 0.34, z],
            [0.225, 0.28, -0.08],
          ],
          0.016,
          carbon,
        );
    } else if (kind === 'flamethrower') {
      // The dorsal tank pack has two separate straps and a padded back plate.
      patch(part, 0.261, 0.53, 1.43, -2.58, -0.55, carbon);
      for (const x of [-0.14, 0.14]) {
        for (const z of [-0.12, -0.27]) collar(part, [x, 0.42, z], 0.145, carbon);
        box(part, [x, 0.365, -0.22], [0.1, 0.04, 0.2], accent);
      }
    }
  }
  return root;
}
