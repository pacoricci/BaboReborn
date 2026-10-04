import type { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import { PRIMARY_MODELS } from '../actors/arsenal';
import type { VisualKit } from '../assets/visual-kit';
import type { ObjectView } from '../view';
import { WorldArt } from './world-art';
import type { WorldModel } from './world-art';
import { WEAPON_PICKUP_RADIANS_PER_SECOND } from './timing';

// Own live object instances; templates and shared materials retain the scene lifetime.
export class ArenaObjects {
  private objects = new Map<number, { node: WorldModel; kind: string }>();
  private worldArt: WorldArt;
  private readonly restingRotation = Quaternion.Identity();
  private objectMaterials = new Map<string, StandardMaterial>();

  constructor(
    private scene: Scene,
    kit: Pick<VisualKit, 'models' | 'flash'>,
  ) {
    this.worldArt = new WorldArt(scene, this.sharedMaterial, kit);
  }

  private material(name: string, hex: string, emissive = 0): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = Color3.FromHexString(hex);
    material.specularColor = new Color3(0.07, 0.07, 0.06);
    if (emissive) material.emissiveColor = material.diffuseColor.scale(emissive);
    return material;
  }

  private sharedMaterial = (name: string, hex: string, emissive = 0): StandardMaterial => {
    let material = this.objectMaterials.get(name);
    if (!material) {
      material = this.material(name, hex, emissive);
      this.objectMaterials.set(name, material);
    }
    return material;
  };

  snapshot() {
    return Array.from(this.objects, ([id, { node, kind }]) => ({
      id,
      kind,
      aim: node.turretHead?.rotation.y,
      muzzle: node.muzzle?.isEnabled(),
    }));
  }

  render(objects: readonly ObjectView[], dt: number): void {
    const present = new Set<number>();
    for (const object of objects) {
      present.add(object.id);
      let entry = this.objects.get(object.id);
      if (entry && entry.kind !== object.kind) {
        entry.node.dispose();
        this.objects.delete(object.id);
        entry = undefined;
      }
      if (!entry) {
        entry = { node: this.worldArt.create(object.kind), kind: object.kind };
        this.objects.set(object.id, entry);
      }
      const node = entry.node;
      node.position.set(
        object.x,
        Math.max(object.kind === 'flame' ? 0.02 : 0.08, object.z),
        object.y,
      );
      // Positive yaw turns clockwise when viewed from above.
      if (PRIMARY_MODELS.includes(object.kind))
        node.rotation.y =
          (node.rotation.y + WEAPON_PICKUP_RADIANS_PER_SECOND * Math.max(0, dt)) % (2 * Math.PI);
      // Zero velocity has no heading; preserve the last yaw while a throwable settles.
      else if (
        object.angle !== undefined &&
        object.kind !== 'minibot' &&
        object.throwMotion?.moving !== false
      )
        node.rotation.y = Math.PI / 2 - object.angle;
      if (node.throwable) {
        const rotation = (node.throwable.rotationQuaternion ??= Quaternion.Identity());
        const motion = object.throwMotion;
        if (motion?.moving) {
          // Absolute projectile age keeps tumbling stable across frame rates and late loads.
          // Spin the art beneath the trajectory yaw, never the authoritative position.
          const age = motion.age;
          Quaternion.RotationYawPitchRollToRef(
            age * (object.kind === 'grenade' ? 0.95 : 0.6),
            age * (object.kind === 'grenade' ? 2.5 : 1.75),
            Math.sin(age) * 0.3,
            rotation,
          );
        } else if (motion) {
          Quaternion.SlerpToRef(
            rotation,
            this.restingRotation,
            1 - Math.exp(-14 * Math.max(0, dt)),
            rotation,
          );
        } else rotation.copyFrom(this.restingRotation);
      }
      if (node.turretHead && object.turret)
        node.turretHead.rotation.y = Math.PI / 2 - object.turret.angle;
      if (node.muzzle) node.muzzle.setEnabled((object.turret?.shotAge ?? Infinity) < 0.08);
      if (object.kind === 'flame') node.rotation.y = object.id;
    }
    for (const [id, entry] of this.objects)
      if (!present.has(id)) {
        entry.node.dispose();
        this.objects.delete(id);
      }
  }
}
