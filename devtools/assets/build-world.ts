import { writeFileSync } from 'node:fs';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { WORLD_MODELS } from '../../frontend/src/presentation/assets/model-catalog';
import { createWorldGeometry } from './world-geometry';
import { modelGLB } from './glb-writer';
export function worldGLB(kind: string): Buffer {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  const materials = new Map<string, StandardMaterial>();
  try {
    const root = createWorldGeometry(scene, kind, (name, hex, glow = 0) => {
      let material = materials.get(name);
      if (!material) {
        material = new StandardMaterial(name, scene);
        material.diffuseColor = Color3.FromHexString(hex);
        material.emissiveColor = material.diffuseColor.scale(glow);
        material.specularColor = new Color3(0.07, 0.07, 0.06);
        materials.set(name, material);
      }
      return material;
    });
    return modelGLB(root);
  } finally {
    scene.dispose();
    engine.dispose();
  }
}
export function buildWorld() {
  for (const kind of WORLD_MODELS)
    writeFileSync(
      new URL(`../../frontend/public/assets/kit/models/${kind}.glb`, import.meta.url),
      worldGLB(kind),
    );
  console.log(`Built ${WORLD_MODELS.length} world and actor GLBs.`);
}
