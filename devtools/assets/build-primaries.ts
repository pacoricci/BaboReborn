import { writeFileSync, mkdirSync } from 'node:fs';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { createPrimary } from './primary-geometry';
import { PRIMARY_MODELS } from '../../frontend/src/presentation/actors/arsenal';
import { modelGLB } from './glb-writer';
export function primaryGLB(kind: string): Buffer {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const root = createPrimary(
      scene,
      kind,
      new TransformNode('authoring', scene),
      (name, hex, glow = 0) => {
        const mat = new StandardMaterial(name, scene);
        mat.diffuseColor = Color3.FromHexString(hex);
        mat.specularColor = new Color3(0.07, 0.07, 0.06);
        mat.emissiveColor = mat.diffuseColor.scale(glow);
        return mat;
      },
    );
    return modelGLB(root);
  } finally {
    scene.dispose();
    engine.dispose();
  }
}
export function buildPrimaries() {
  const out = new URL('../../frontend/public/assets/kit/models/', import.meta.url);
  mkdirSync(out, { recursive: true });
  for (const kind of PRIMARY_MODELS) writeFileSync(new URL(`${kind}.glb`, out), primaryGLB(kind));
  console.log(`Built ${PRIMARY_MODELS.length} primary GLBs.`);
}
