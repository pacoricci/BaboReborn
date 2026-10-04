import '@babylonjs/core/Meshes/instancedMesh';
import { createSMG } from './smg-geometry';
// Authored low-poly equipment. Geometry is cosmetic; muzzle anchors come from tuning.
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import {
  DUAL,
  CHAIN,
  SNIPER,
  BAZOOKA,
  PHOTON,
  FLAMETHROWER,
  SHOTGUN,
  SMG_MUZZLE,
} from '../../frontend/src/gameconfig/tuning';

import { ARSENAL_COLORS } from '../../frontend/src/presentation/actors/arsenal';
const muzzleRules = {
  shotgun: { ...SHOTGUN, muzzleHeight: SMG_MUZZLE.height },
  dual: DUAL,
  chain: CHAIN,
  sniper: SNIPER,
  bazooka: BAZOOKA,
  photon: PHOTON,
  flamethrower: FLAMETHROWER,
};
type MaterialFactory = (name: string, color: string, glow?: number) => StandardMaterial;
type Part = 'static' | 'rotor' | 'charge';
interface PrimaryModel extends TransformNode {
  rotor?: TransformNode;
  charge?: TransformNode;
  chargeMeshes?: ReturnType<TransformNode['getChildMeshes']>;
}
const templates = new WeakMap<Scene, Map<string, { mesh: Mesh; part: Part }[]>>();

export function createPrimary(
  scene: Scene,
  kind: string,
  parent: TransformNode,
  material: MaterialFactory,
): PrimaryModel {
  if (kind === 'smg') {
    const root = createSMG(scene);
    root.parent = parent;
    return root;
  }
  let cache = templates.get(scene);
  if (!cache) {
    cache = new Map();
    templates.set(scene, cache);
  }
  let parts = cache.get(kind);
  if (!parts) {
    const rules = muzzleRules[kind as keyof typeof muzzleRules] ?? muzzleRules.shotgun;
    const groups = new Map<string, { material: StandardMaterial; meshes: Mesh[]; part: Part }>();
    let part: Part = 'static';
    const metal = material('equipment-steel', '#81939a');
    const dark = material('equipment-dark-steel', '#27353e');
    const rubber = material('equipment-rubber', '#27353e');
    const bore = material('equipment-recess', '#080f14');
    const accent = material(`equipment-${kind}`, ARSENAL_COLORS[kind] ?? '#c5d697');
    const light = material(`equipment-${kind}-light`, ARSENAL_COLORS[kind] ?? '#c5d697', 0.6);
    const add = (mesh: Mesh, x: number, y: number, z: number, mat: StandardMaterial) => {
      mesh.position.set(x, y, z);
      mesh.material = mat;
      mesh.isPickable = false;
      const key = `${part}:${mat.uniqueId}`;
      const group = groups.get(key) ?? { material: mat, meshes: [], part };
      group.meshes.push(mesh);
      groups.set(key, group);
      return mesh;
    };
    // Flat bevel faces keep the silhouette legible at gameplay scale.
    const box = (x: number, y: number, z: number, w: number, h: number, d: number, mat = metal) => {
      // Subpixel rail teeth and grooves do not benefit from a full beveled hull.
      if (Math.min(w, h, d) < 0.028)
        return add(
          MeshBuilder.CreateBox(`${kind}-detail`, { width: w, height: h, depth: d }, scene),
          x,
          y,
          z,
          mat,
        );
      const bevel = Math.min(w, h, d) * 0.18;
      const mesh = new Mesh(`${kind}-housing`, scene);
      const positions: number[] = [],
        indices: number[] = [];
      for (const [height, inset] of [
        [-h / 2, bevel],
        [-h / 2 + bevel, 0],
        [h / 2 - bevel, 0],
        [h / 2, bevel],
      ]) {
        const a = w / 2 - inset!,
          b = d / 2 - inset!,
          c = Math.max(0.0001, bevel - inset! * 0.5);
        for (const [px, pz] of [
          [-a + c, -b],
          [a - c, -b],
          [a, -b + c],
          [a, b - c],
          [a - c, b],
          [-a + c, b],
          [-a, b - c],
          [-a, -b + c],
        ])
          positions.push(px!, height!, pz!);
      }
      for (let ring = 0; ring < 3; ring++)
        for (let i = 0; i < 8; i++) {
          const a = ring * 8 + i,
            b = ring * 8 + ((i + 1) % 8);
          indices.push(a, b, b + 8, a, b + 8, a + 8);
        }
      for (let i = 1; i < 7; i++) indices.push(0, i + 1, i, 24, 24 + i, 25 + i);
      const data = new VertexData();
      data.positions = positions;
      data.indices = indices;
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, indices, normals);
      data.normals = normals;
      data.uvs = positions.flatMap((_, i) =>
        i % 3 === 0 ? [positions[i]!, positions[i + 2]!] : [],
      );
      data.applyToMesh(mesh);
      mesh.convertToFlatShadedMesh();
      return add(mesh, x, y, z, mat);
    };
    const tube = (
      x: number,
      y: number,
      end: number,
      diameter: number,
      length: number,
      mat = metal,
    ) => {
      const mesh = add(
        MeshBuilder.CreateCylinder(
          `${kind}-tube`,
          { diameter, height: length, tessellation: 10 },
          scene,
        ),
        x,
        y,
        end - length / 2,
        mat,
      );
      mesh.rotation.x = Math.PI / 2;
      return mesh;
    };
    // A recessed inner wall and rear disk leave a real opening at the muzzle anchor.
    const muzzle = (
      x: number,
      y: number,
      z: number,
      diameter: number,
      length: number,
      mat = metal,
    ) => {
      const r = diameter / 2;
      const mesh = MeshBuilder.CreateLathe(
        `${kind}-muzzle`,
        {
          shape: [
            new Vector3(r * 0.72, -length, 0),
            new Vector3(r, -length * 0.78, 0),
            new Vector3(r, -0.007, 0),
            new Vector3(r * 0.88, 0, 0),
            new Vector3(r * 0.62, 0, 0),
            new Vector3(r * 0.62, -length * 0.8, 0),
          ],
          tessellation: 12,
          cap: Mesh.NO_CAP,
        },
        scene,
      );
      mesh.rotation.x = Math.PI / 2;
      add(mesh, x, y, z, mat);
      tube(x, y, z - length * 0.8, diameter * 0.63, 0.005, bore);
    };
    const ribbedGrip = (
      x: number,
      y: number,
      end: number,
      w: number,
      length: number,
      mat: StandardMaterial,
    ) => {
      box(x, y, end - length / 2, w, 0.085, length, mat);
      for (let i = 1; i < 6; i++)
        box(x, y + 0.042, end - (i * length) / 6, w * 0.93, 0.012, 0.014, rubber);
    };
    const rail = (x: number, y: number, z: number, length: number) => {
      box(x, y, z, 0.035, 0.018, length, dark);
      for (let i = 0; i < 5; i++)
        box(x, y + 0.012, z - length * 0.4 + i * length * 0.2, 0.046, 0.009, 0.014);
    };
    const x = rules.muzzleRight,
      y = rules.muzzleHeight,
      z = rules.muzzleForward;
    if (kind === 'dual') {
      for (const [bx, by, bz] of [
        [x, y, z],
        [DUAL.muzzleRight2, DUAL.muzzleHeight2, DUAL.muzzleForward2],
      ] as [number, number, number][]) {
        tube(bx, by, bz - 0.05, 0.052, 0.24, dark);
        muzzle(bx, by, bz, 0.085, 0.06);
        box(bx, by, bz - 0.25, 0.12, 0.1, 0.22, dark);
        box(bx, by + 0.048, bz - 0.25, 0.1, 0.035, 0.19, accent);
        ribbedGrip(bx, by - 0.015, bz - 0.075, 0.095, 0.095, metal);
        rail(bx, by + 0.077, bz - 0.25, 0.12);
        box(bx, by - 0.105, bz - 0.23, 0.07, 0.14, 0.085, rubber).rotation.x = -0.18;
        box(bx, by - 0.15, bz - 0.24, 0.082, 0.025, 0.09, accent);
        box(bx, by - 0.07, bz - 0.34, 0.06, 0.1, 0.05, dark).rotation.x = -0.25;
        box(bx, by + 0.005, bz - 0.395, 0.07, 0.06, 0.1, metal);
        box(bx, by, bz - 0.446, 0.09, 0.1, 0.022, rubber);
      }
    } else if (kind === 'chain') {
      part = 'rotor';
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3,
          bx = x + Math.cos(a) * 0.062,
          by = y + Math.sin(a) * 0.062;
        tube(bx, by, z - 0.028, 0.037, 0.36, metal);
        muzzle(bx, by, z, 0.045, 0.035, dark);
      }
      tube(x, y, z - 0.065, 0.2, 0.04, dark);
      tube(x, y, z - 0.1, 0.19, 0.017, accent);
      tube(x, y, z - 0.3, 0.21, 0.07, dark);
      part = 'static';
      box(x, y, z - 0.435, 0.23, 0.18, 0.24, dark);
      box(x, y + 0.095, z - 0.43, 0.2, 0.035, 0.18, accent);
      tube(x + 0.17, y - 0.015, z - 0.34, 0.23, 0.2, accent);
      tube(x + 0.17, y - 0.015, z - 0.335, 0.17, 0.015, dark);
      tube(x + 0.17, y - 0.015, z - 0.329, 0.075, 0.018);
      for (let i = 0; i < 5; i++)
        box(x - 0.12, y + 0.025, z - 0.35 - i * 0.034, 0.016, 0.05, 0.014, metal);
      box(x, y + 0.16, z - 0.46, 0.04, 0.028, 0.17, metal);
      for (const at of [0.39, 0.53]) box(x, y + 0.12, z - at, 0.035, 0.07, 0.025, dark);
      box(x, y - 0.12, z - 0.5, 0.08, 0.12, 0.07, rubber);
    } else if (kind === 'bazooka') {
      tube(x, y, z - 0.09, 0.235, 0.5, accent);
      muzzle(x, y, z, 0.29, 0.12, dark);
      tube(x, y, z - 0.125, 0.248, 0.025, metal);
      muzzle(x, y, z - 0.57, 0.28, 0.12, metal);
      for (const at of [0.3, 0.49]) tube(x, y, z - at, 0.249, 0.037, dark);
      box(x, y + 0.11, z - 0.3, 0.05, 0.1, 0.055, metal);
      box(x, y + 0.17, z - 0.3, 0.1, 0.025, 0.08, dark);
      box(x, y - 0.16, z - 0.4, 0.075, 0.14, 0.07, rubber).rotation.x = -0.2;
      box(x, y - 0.125, z - 0.52, 0.12, 0.065, 0.14, rubber);
      for (let i = 0; i < 3; i++)
        box(x - 0.065, y + 0.1, z - 0.19 - i * 0.025, 0.035, 0.01, 0.012, metal);
    } else if (kind === 'photon') {
      tube(x, y, z - 0.05, 0.095, 0.37, dark);
      muzzle(x, y, z, 0.16, 0.065, metal);
      for (const side of [-1, 1]) {
        box(x + side * 0.092, y, z - 0.2, 0.055, 0.13, 0.3, metal);
        box(x + side * 0.11, y + 0.05, z - 0.2, 0.032, 0.024, 0.23, accent);
      }
      for (let i = 0; i < 4; i++) {
        tube(x, y, z - 0.09 - i * 0.065, 0.155, 0.022, dark);
        part = 'charge';
        tube(x, y, z - 0.098 - i * 0.065, 0.158, 0.01, light);
        part = 'static';
      }
      box(x, y, z - 0.435, 0.22, 0.16, 0.22, dark);
      box(x, y + 0.072, z - 0.445, 0.18, 0.045, 0.19, metal);
      part = 'charge';
      box(x, y + 0.1, z - 0.425, 0.055, 0.022, 0.14, light);
      tube(x, y, z - 0.038, 0.085, 0.01, light);
      part = 'static';
      box(x, y - 0.11, z - 0.46, 0.07, 0.14, 0.085, rubber).rotation.x = -0.22;
      box(x, y, z - 0.59, 0.125, 0.11, 0.13, metal);
      box(x, y, z - 0.66, 0.15, 0.14, 0.025, rubber);
    } else if (kind === 'flamethrower') {
      tube(x, y, z - 0.055, 0.08, 0.3, metal);
      muzzle(x, y, z, 0.17, 0.115, dark);
      tube(x, y, z - 0.1, 0.16, 0.022, accent);
      box(x, y, z - 0.365, 0.18, 0.145, 0.22, dark);
      for (const side of [-1, 1]) {
        // Fuel is carried on the Babo's back; flexible feeds reach the side nozzle.
        const bx = side * 0.14;
        tube(bx, 0.42, -0.055, 0.13, 0.28, accent);
        tube(bx, 0.42, -0.05, 0.085, 0.018, metal);
        tube(bx, 0.42, -0.33, 0.1, 0.02, dark);
        const hose = MeshBuilder.CreateTube(
          `${kind}-fuel-feed`,
          {
            path: [
              new Vector3(bx, 0.42, -0.33),
              new Vector3(bx, 0.32, -0.37),
              new Vector3(0.13, 0.25, -0.37 - (side < 0 ? 0.025 : 0)),
              new Vector3(0.28, 0.24, -0.23),
              new Vector3(0.29, y, -0.06),
              new Vector3(x + side * 0.025, y, z - 0.23),
            ],
            radius: 0.013,
            tessellation: 8,
            cap: Mesh.CAP_ALL,
          },
          scene,
        );
        add(hose, 0, 0, 0, rubber);
      }
      rail(x, y + 0.088, z - 0.36, 0.12);
      tube(x, y - 0.09, z - 0.008, 0.026, 0.14, metal);
      tube(x, y - 0.09, z - 0.005, 0.022, 0.025, light);
      box(x, y - 0.12, z - 0.42, 0.07, 0.14, 0.065, rubber).rotation.x = -0.2;
    } else if (kind === 'sniper') {
      // A tapered shoulder stock, receiver and fore-end carry the rifle silhouette.
      const stock = new Mesh('sniper-stock', scene);
      const positions: number[] = [],
        indices: number[] = [];
      for (const [back, height, width, depth] of [
        [0.88, -0.035, 0.115, 0.17],
        [0.81, -0.024, 0.12, 0.15],
        [0.7, 0, 0.085, 0.085],
        [0.59, -0.008, 0.072, 0.065],
      ] as const) {
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const)
          positions.push((sx * width) / 2, height + (sy * depth) / 2, -back);
      }
      for (let ring = 0; ring < 3; ring++)
        for (let i = 0; i < 4; i++) {
          const a = ring * 4 + i,
            b = ring * 4 + ((i + 1) % 4);
          indices.push(a, b, b + 4, a, b + 4, a + 4);
        }
      indices.push(0, 2, 1, 0, 3, 2, 12, 13, 14, 12, 14, 15);
      const stockData = new VertexData();
      stockData.positions = positions;
      stockData.indices = indices;
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, indices, normals);
      stockData.normals = normals;
      stockData.uvs = positions.flatMap((_, i) =>
        i % 3 === 0 ? [positions[i + 2]!, positions[i + 1]!] : [],
      );
      stockData.applyToMesh(stock);
      stock.convertToFlatShadedMesh();
      add(stock, x, y, z, accent);
      box(x, y - 0.035, z - 0.887, 0.13, 0.18, 0.026, rubber);
      box(x, y + 0.055, z - 0.78, 0.095, 0.03, 0.16, rubber);

      tube(x, y, z - 0.04, 0.046, 0.47, metal);
      tube(x, y, z - 0.235, 0.058, 0.08, dark);
      muzzle(x, y, z, 0.068, 0.065, dark);
      for (const side of [-1, 1])
        for (let i = 0; i < 2; i++)
          box(x + side * 0.034, y, z - 0.02 - i * 0.023, 0.006, 0.025, 0.012, bore);
      box(x, y - 0.023, z - 0.35, 0.106, 0.105, 0.235, accent);
      box(x, y + 0.025, z - 0.505, 0.116, 0.085, 0.235, dark);
      box(x, y - 0.035, z - 0.52, 0.108, 0.07, 0.2, accent);
      for (const side of [-1, 1])
        for (let i = 0; i < 4; i++)
          box(x + side * 0.053, y - 0.015, z - 0.275 - i * 0.041, 0.008, 0.032, 0.022, bore);
      box(x, y - 0.115, z - 0.475, 0.072, 0.115, 0.084, dark).rotation.x = 0.12;
      box(x, y - 0.17, z - 0.468, 0.081, 0.022, 0.092, metal);
      box(x, y - 0.112, z - 0.622, 0.072, 0.16, 0.068, rubber).rotation.x = -0.32;
      // The open trigger guard separates the grip from the short box magazine.
      box(x, y - 0.09, z - 0.537, 0.018, 0.08, 0.018, dark);
      box(x, y - 0.128, z - 0.575, 0.023, 0.018, 0.094, dark);
      box(x, y - 0.083, z - 0.581, 0.015, 0.055, 0.015, metal).rotation.x = -0.25;

      rail(x, y + 0.073, z - 0.51, 0.245);
      for (const at of [0.425, 0.575]) {
        box(x, y + 0.103, z - at, 0.06, 0.04, 0.028, metal);
        tube(x, y + 0.143, z - at + 0.013, 0.078, 0.026, metal);
      }
      tube(x, y + 0.143, z - 0.365, 0.054, 0.26, dark);
      muzzle(x, y + 0.143, z - 0.325, 0.091, 0.085, dark);
      tube(x, y + 0.143, z - 0.348, 0.055, 0.008, light);
      tube(x, y + 0.143, z - 0.612, 0.07, 0.052, rubber);
      box(x, y + 0.185, z - 0.5, 0.045, 0.052, 0.045, dark);
      tube(x + 0.04, y + 0.145, z - 0.48, 0.038, 0.037, dark).rotation.y = Math.PI / 2;
      box(x + 0.06, y + 0.031, z - 0.5, 0.008, 0.03, 0.067, bore);
      box(x + 0.085, y + 0.015, z - 0.574, 0.08, 0.02, 0.02, metal).rotation.z = -0.4;
      box(x + 0.119, y - 0.004, z - 0.574, 0.037, 0.038, 0.034, rubber);
    } else {
      // Front-heavy proportions keep the shotgun legible at overhead scale.
      tube(x, y, z - 0.07, 0.12, 0.35, metal);
      muzzle(x, y, z, 0.18, 0.105, dark);
      tube(x, y, z - 0.09, 0.155, 0.035, metal);
      for (const at of [0.16, 0.3]) tube(x, y, z - at, 0.138, 0.035, dark);
      box(x, y + 0.062, z - 0.23, 0.065, 0.035, 0.235, dark);
      for (let i = 0; i < 4; i++)
        box(x, y + 0.083, z - 0.15 - i * 0.048, 0.075, 0.014, 0.023, metal);
      box(x, y + 0.015, z - 0.445, 0.225, 0.18, 0.22, dark);
      box(x, y + 0.106, z - 0.445, 0.19, 0.04, 0.195, metal);
      for (const side of [-1, 1])
        box(x + side * 0.109, y + 0.025, z - 0.455, 0.025, 0.11, 0.16, accent);
      box(x + 0.126, y + 0.046, z - 0.415, 0.009, 0.045, 0.085, bore);
      box(x, y - 0.025, z - 0.615, 0.18, 0.19, 0.17, accent).rotation.x = -0.12;
      box(x, y + 0.071, z - 0.62, 0.16, 0.04, 0.14, dark);
      box(x, y - 0.038, z - 0.706, 0.205, 0.215, 0.04, rubber);
      box(x, y - 0.135, z - 0.505, 0.095, 0.14, 0.085, rubber).rotation.x = -0.3;
      box(x, y - 0.202, z - 0.525, 0.11, 0.03, 0.095, metal);
      rail(x, y + 0.137, z - 0.44, 0.16);
      box(x, y + 0.098, z - 0.045, 0.04, 0.035, 0.038, accent);
      // Oversized upright shells break up the receiver's broad overhead silhouette.
      box(x - 0.135, y + 0.005, z - 0.447, 0.045, 0.11, 0.215, dark);
      for (let i = 0; i < 4; i++) {
        const shellZ = z - 0.365 - i * 0.052;
        tube(x - 0.152, y + 0.025, shellZ + 0.052, 0.043, 0.104, accent).rotation.x = 0;
        tube(x - 0.152, y + 0.083, shellZ + 0.009, 0.047, 0.018, metal).rotation.x = 0;
      }
    }
    // Merge by material once per scene; all actors and dropped weapons share these buffers.
    parts = [];
    for (const { material: mat, meshes, part } of groups.values()) {
      const merged = Mesh.MergeMeshes(meshes, true, true)!;
      merged.name = `template-${kind}-${mat.name}`;
      merged.material = mat;
      merged.isPickable = false;
      merged.setEnabled(false);
      parts.push({ mesh: merged, part });
    }
    cache.set(kind, parts);
  }
  const root: PrimaryModel = new TransformNode(`weapon-${kind}`, scene);
  root.parent = parent;
  for (const { mesh, part } of parts) {
    let parent: TransformNode = root;
    if (part !== 'static') {
      if (!root[part]) root[part] = new TransformNode(`${kind}-${part}`, scene);
      parent = root[part]!;
      parent.parent = root;
    }
    const instance = mesh.createInstance(`${kind}-${part}-instance`);
    instance.parent = parent;
    instance.isPickable = false;
    if (part === 'rotor') {
      // The rotor pivots around its own barrel axis; the body's aim frame stays fixed.
      parent.position.set(CHAIN.muzzleRight, CHAIN.muzzleHeight, CHAIN.muzzleForward - 0.2);
      instance.position.subtractInPlace(parent.position);
    }
  }
  if (root.charge) root.chargeMeshes = root.charge.getChildMeshes();
  if (root.charge)
    root.charge.setPivotPoint(
      new Vector3(PHOTON.muzzleRight, PHOTON.muzzleHeight, PHOTON.muzzleForward),
    );
  return root;
}
