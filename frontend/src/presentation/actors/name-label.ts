import { nicknameRuns } from '../../player/nickname';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';

export function createNameLabel(scene: Scene, root: TransformNode) {
  const texture = new DynamicTexture(`${root.name}-name`, { width: 512, height: 64 }, scene, false);
  texture.hasAlpha = true;
  const material = new StandardMaterial(`${root.name}-name`, scene);
  material.diffuseTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  const mesh = MeshBuilder.CreateGround(`${root.name}-name`, { width: 1.6, height: 0.2 }, scene);
  mesh.parent = root;
  mesh.position.set(0, 0.04, 0.53);
  mesh.material = material;
  mesh.isPickable = false;
  root.onDisposeObservable.addOnce(() => material.dispose(false, true));
  let current = '';
  return {
    update(nickname: string, colors?: string) {
      mesh.setEnabled(!!nickname);
      const key = nickname + ':' + (colors ?? '');
      if (key === current) return;
      current = key;
      // Upload text only when the name changes, never on movement or aim updates.
      const context = texture.getContext() as CanvasRenderingContext2D;
      context.clearRect(0, 0, 512, 64);
      context.font = '500 40px "Courier New", monospace';
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.lineWidth = 5;
      context.strokeStyle = '#10171b';
      const width = context.measureText(nickname).width;
      context.save();
      context.translate(256, 0);
      context.scale(Math.min(1, 496 / Math.max(1, width)), 1);
      let x = -width / 2;
      for (const run of nicknameRuns(nickname, colors)) {
        context.fillStyle = run.color || '#edf2ef';
        context.strokeText(run.text, x, 32);
        context.fillText(run.text, x, 32);
        x += context.measureText(run.text).width;
      }
      context.restore();
      texture.update();
    },
  };
}
