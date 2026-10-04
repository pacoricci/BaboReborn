import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { createBox, createCylinder } from './geometry-primitives';

// Muzzle at the origin; body extends 0.4 cells backwards. The actor owns the muzzle offset.
export function createSMG(scene: Scene): TransformNode {
  const root = new TransformNode('weapon-smg', scene);
  const material = (name: string, color: [number, number, number], metallic = 0.05) => {
    const mat = new PBRMaterial(name, scene);
    mat.albedoColor = Color3.FromArray(color);
    mat.metallic = metallic;
    mat.roughness = 0.65;
    return mat;
  };
  const gunmetal = material('gunmetal', [0.24, 0.32, 0.36]);
  const steel = material('steel', [0.51, 0.59, 0.63], 0.45);
  const rubber = material('rubber', [0.035, 0.055, 0.065]);
  const coating = material('sage-finish', [0.39, 0.57, 0.49]);
  const darkSteel = material('dark-steel', [0.035, 0.055, 0.065]);
  const recess = material('recess', [0.035, 0.055, 0.065]);
  const groups = new Map<PBRMaterial, Mesh[]>();
  const add = (mesh: Mesh, at: [number, number, number], mat: PBRMaterial) => {
    mesh.position.copyFromFloats(...at);
    mesh.material = mat;
    const group = groups.get(mat) ?? [];
    group.push(mesh);
    groups.set(mat, group);
  };
  add(createBox(scene, 'receiver', [0.108, 0.09, 0.2], 0.014), [0, 0, -0.22], gunmetal);
  add(createBox(scene, 'upper-rail', [0.042, 0.016, 0.17]), [0, 0.057, -0.23], steel);
  add(createBox(scene, 'foregrip', [0.097, 0.075, 0.11], 0.012), [0, -0.003, -0.1], coating);
  add(createCylinder(scene, 'barrel', 0.028, 0.052, 0.018), [0, 0, -0.026], steel);
  add(createCylinder(scene, 'muzzle-cap', 0.018, 0.002), [0, 0, -0.047], recess);
  add(createBox(scene, 'magazine', [0.037, 0.1, 0.055]), [0, -0.067, -0.2], darkSteel);
  add(createBox(scene, 'grip', [0.041, 0.085, 0.04]), [0, -0.066, -0.3], rubber);
  add(createBox(scene, 'stock', [0.065, 0.052, 0.075], 0.008), [0, -0.009, -0.3575], gunmetal);
  add(createBox(scene, 'stock-pad', [0.065, 0.072, 0.015], 0.007), [0, -0.016, -0.3925], rubber);
  add(createBox(scene, 'front-sight', [0.018, 0.025, 0.014]), [0, 0.044, -0.063], gunmetal);
  add(createBox(scene, 'ejection-port', [0.003, 0.025, 0.064]), [-0.055, 0.004, -0.2], recess);
  add(createBox(scene, 'handguard-groove-0', [0.09, 0.01, 0.008]), [0, 0.035, -0.06], rubber);
  add(createBox(scene, 'handguard-groove-1', [0.09, 0.01, 0.008]), [0, 0.035, -0.083], rubber);
  add(createBox(scene, 'handguard-groove-2', [0.09, 0.01, 0.008]), [0, 0.035, -0.106], rubber);
  add(createBox(scene, 'handguard-groove-3', [0.09, 0.01, 0.008]), [0, 0.035, -0.129], rubber);
  add(createBox(scene, 'rail-tooth-0', [0.055, 0.008, 0.014]), [0, 0.069, -0.16], darkSteel);
  add(createBox(scene, 'rail-tooth-1', [0.055, 0.008, 0.014]), [0, 0.069, -0.191], darkSteel);
  add(createBox(scene, 'rail-tooth-2', [0.055, 0.008, 0.014]), [0, 0.069, -0.222], darkSteel);
  add(createBox(scene, 'rail-tooth-3', [0.055, 0.008, 0.014]), [0, 0.069, -0.253], darkSteel);
  add(createBox(scene, 'rail-tooth-4', [0.055, 0.008, 0.014]), [0, 0.069, -0.284], darkSteel);
  add(createBox(scene, 'receiver-panel', [0.08, 0.015, 0.095], 0.003), [0, 0.048, -0.225], coating);
  add(createBox(scene, 'rear-sight', [0.05, 0.025, 0.023], 0.005), [0, 0.083, -0.295], steel);
  add(createBox(scene, 'magazine-foot', [0.05, 0.023, 0.065], 0.004), [0, -0.116, -0.2], steel);
  add(
    createBox(scene, 'charging-handle', [0.024, 0.014, 0.042], 0.003),
    [0.045, 0.049, -0.22],
    steel,
  );
  for (const [mat, meshes] of groups) {
    const mesh = Mesh.MergeMeshes(meshes, true, true)!;
    mesh.name = `smg-static-${mat.name}`;
    mesh.material = mat;
    mesh.parent = root;
    mesh.isPickable = false;
  }
  return root;
}
