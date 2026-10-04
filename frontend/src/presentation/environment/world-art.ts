import { SMG_MUZZLE } from '../../gameconfig/tuning';
import { fireMaterial } from '../effects/fire';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PRIMARY_MODELS } from '../actors/arsenal';
import { WORLD_MODELS } from '../assets/model-catalog';
import type { VisualKit } from '../assets/visual-kit';
export interface WorldModel extends TransformNode {
  throwable?: TransformNode;
  turretHead?: TransformNode | undefined;
  muzzle?: AbstractMesh | undefined;
}
// Models own their pending attachment; effects remain controlled by the presentation state.
export class WorldArt {
  private effectTemplates = new Map<string, Mesh>();
  private effect(name: string, build: () => Mesh): Mesh {
    let template = this.effectTemplates.get(name);
    if (!template) {
      template = build();
      template.setEnabled(false);
      this.effectTemplates.set(name, template);
    }
    const mesh = template.clone(name, null);
    mesh.setEnabled(true);
    return mesh;
  }

  constructor(
    private scene: Scene,
    private material: (name: string, color: string, glow?: number) => StandardMaterial,
    private kit: Pick<VisualKit, 'models' | 'flash'>,
  ) {}
  create(kind: string): WorldModel {
    const root: WorldModel = new TransformNode(`object-${kind}`, this.scene);
    if (PRIMARY_MODELS.includes(kind)) {
      const gun = this.kit.models.create(kind, root);
      gun.position.set(
        kind === 'smg' ? -SMG_MUZZLE.right : 0,
        0.04 - (kind === 'smg' ? SMG_MUZZLE.height : 0),
        kind === 'smg' ? 0.2 - SMG_MUZZLE.forward : 0,
      );
    } else if (WORLD_MODELS.includes(kind)) {
      const model = this.kit.models.create(kind, root);
      if (kind === 'grenade' || kind === 'molotov') root.throwable = model;
      if (kind === 'minibot') {
        root.turretHead = model.parts.get('turret-head');
        const flash = this.effect('turret-muzzle', () =>
          MeshBuilder.CreateGround('turret-muzzle', { width: 0.14, height: 0.22 }, this.scene),
        );
        flash.parent = root.turretHead!;
        flash.position.set(0, 0.225, 0.35);
        flash.material = this.kit.flash;
        flash.isPickable = false;
        flash.setEnabled(false);
        root.muzzle = flash;
      } else if (kind === 'rocket') {
        const exhaust = this.effect('rocket-exhaust', () =>
          MeshBuilder.CreateCylinder(
            'rocket-exhaust',
            { diameterBottom: 0.07, diameterTop: 0, height: 0.22, tessellation: 10 },
            this.scene,
          ),
        );
        exhaust.parent = root;
        exhaust.position.z = -0.24;
        exhaust.rotation.x = -Math.PI / 2;
        exhaust.material = this.material('rocket-exhaust', '#ffc370', 0.7);
        exhaust.isPickable = false;
      }
    } else if (kind === 'flame') {
      const flame = this.effect('fire-pool', () => {
        const wisps: Mesh[] = [];
        for (let i = 0; i < 18; i++) {
          const wisp = MeshBuilder.CreateGround(
            'fire-wisp',
            { width: 0.8, height: 0.8 },
            this.scene,
          );
          wisp.setVerticesData('uv2', [i, 0, i, 0, i, 0, i, 0]);
          wisps.push(wisp);
        }
        const mesh = Mesh.MergeMeshes(wisps, true)!;
        mesh.name = 'fire-pool';
        mesh.material = fireMaterial(this.scene);
        mesh.isPickable = false;
        return mesh;
      });
      // Cloning recomputes bounds from flat geometry; include the GPU motion on each instance.
      flame.setBoundingInfo(
        new BoundingInfo(new Vector3(-0.65, -0.15, -0.65), new Vector3(0.65, 0.85, 0.65)),
      );
      flame.parent = root;
    } else throw new Error(`Unknown world visual: ${kind}`);
    return root;
  }
}
