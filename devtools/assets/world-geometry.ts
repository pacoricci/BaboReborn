import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { createBox } from './geometry-primitives';
import { createObjectiveGeometry } from './objective-geometry';
// Editable authored models. No effects, network, map or lifecycle rules.
import { createWeaponMount } from './weapon-mount-geometry';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { createSecondaryGeometry } from './secondary-geometry';
import type { Scene } from '@babylonjs/core/scene';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { ARSENAL_COLORS } from '../../frontend/src/presentation/actors/arsenal';
export function createWorldGeometry(
  scene: Scene,
  kind: string,
  material: (name: string, hex: string, glow?: number) => StandardMaterial,
): TransformNode {
  if (kind.startsWith('flag-') || kind.startsWith('base-'))
    return createObjectiveGeometry(scene, kind, material);
  if (kind === 'knives' || kind === 'grenade' || kind === 'molotov')
    return createSecondaryGeometry(scene, kind, material);
  if (kind === 'weapon-mount') return createWeaponMount(scene, material);
  const root = new TransformNode(kind, scene);
  if (kind === 'wall') {
    const wall = createBox(scene, 'wall', [1, 1, 1]);
    const mat = new PBRMaterial('gunmetal', scene);
    mat.albedoColor = new Color3(0.12, 0.15, 0.17);
    mat.metallic = 0.35;
    mat.roughness = 0.65;
    wall.material = mat;
    wall.parent = root;
    wall.isPickable = false;
    return root;
  }
  const dark = material('world-carbon', '#263439');
  const steel = material('world-steel', '#899b9c');
  const color = material(
    `world-${kind}`,
    ARSENAL_COLORS[kind] ?? (kind === 'health' ? '#f2ead6' : '#a2ac6c'),
  );
  const attach = (mesh: Mesh, x: number, y: number, z: number, mat: StandardMaterial) => {
    mesh.parent = root;
    mesh.position.set(x, y, z);
    mesh.material = mat;
    mesh.isPickable = false;
    return mesh;
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, mat = color) =>
    attach(MeshBuilder.CreateBox(kind, { width: w, height: h, depth: d }, scene), x, y, z, mat);
  const tube = (x: number, y: number, z: number, d: number, h: number, mat = color, top = d) =>
    attach(
      MeshBuilder.CreateCylinder(
        kind,
        { diameterBottom: d, diameterTop: top, height: h, tessellation: 10 },
        scene,
      ),
      x,
      y,
      z,
      mat,
    );
  if (kind === 'health') {
    box(0, 0.06, 0, 0.32, 0.14, 0.26);
    box(0, 0.139, 0, 0.08, 0.012, 0.19, material('medkit-cross', '#d54f48'));
    box(0, 0.14, 0, 0.21, 0.012, 0.07, material('medkit-cross', '#d54f48'));
    box(0, 0.04, 0, 0.34, 0.025, 0.28, dark);
  } else if (kind === 'rocket') {
    const body = tube(0, 0, 0, 0.115, 0.3, steel);
    body.rotation.x = Math.PI / 2;
    const nose = tube(0, 0, 0.2, 0.115, 0.12, color, 0);
    nose.rotation.x = Math.PI / 2;
    box(0, 0, -0.1, 0.24, 0.025, 0.12, dark);
    box(0, 0, -0.1, 0.025, 0.2, 0.12, dark);
  } else if (kind === 'minibot') {
    tube(0, 0.015, 0, 0.36, 0.08, dark);
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3;
      const leg = box(Math.sin(a) * 0.18, -0.025, Math.cos(a) * 0.18, 0.07, 0.07, 0.22, steel);
      leg.rotation.y = a;
    }
    tube(0, 0.12, 0, 0.24, 0.17);
    const head = new TransformNode('turret-head', scene);
    head.parent = root;
    box(0, 0.225, 0, 0.26, 0.09, 0.16, dark).parent = head;
    const barrel = tube(0, 0.225, 0.17, 0.05, 0.23, steel);
    barrel.rotation.x = Math.PI / 2;
    barrel.parent = head;
  } else if (kind === 'babo') {
    const ball = MeshBuilder.CreateSphere('babo', { diameter: 0.5, segments: 20 }, scene);
    ball.parent = root;
    ball.material = material('babo-skin', '#ffffff');
  } else throw new Error(`Unknown model recipe: ${kind}`);
  return root;
}
