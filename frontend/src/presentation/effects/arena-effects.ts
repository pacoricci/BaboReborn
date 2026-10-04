// Transient meshes and materials live with one arena scene.
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import type { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { fireMaterial } from './fire';
import { photonMaterial } from './photon';
import { ARSENAL_COLORS } from '../actors/arsenal';
import type { Vec3 } from '../../core/geometry';
import type { ShotView } from '../view';

interface Effect {
  mesh: Mesh;
  life: number;
  total: number;
  expand?: number;
}

export class ArenaEffects {
  private effects: Effect[] = [];
  private tracer: StandardMaterial;
  private flameBurst: ShaderMaterial;
  private photon: ShaderMaterial;
  private impact: StandardMaterial;
  private objectMaterials = new Map<string, StandardMaterial>();

  constructor(private scene: Scene) {
    this.tracer = this.material('tracer', '#edddb0', 1);
    this.flameBurst = fireMaterial(scene, true);
    this.photon = photonMaterial(scene);
    this.impact = this.material('impact', '#e4b87c', 1);
  }

  private material(name: string, hex: string, emissive = 0): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = Color3.FromHexString(hex);
    material.specularColor = new Color3(0.07, 0.07, 0.06);
    if (emissive) material.emissiveColor = material.diffuseColor.scale(emissive);
    return material;
  }

  explosion(position: Vec3, radius: number): void {
    // A low shock ring and brief core leave opponents visible inside the blast.
    const ring = MeshBuilder.CreateTorus(
      'blast-ring',
      { diameter: radius * 2, thickness: 0.04, tessellation: 32 },
      this.scene,
    );
    ring.position.set(position.x, Math.max(0.035, position.z), position.y);
    ring.material = this.impact;
    ring.isPickable = false;
    ring.scaling.setAll(0.25);
    this.effects.push({ mesh: ring, life: 0.32, total: 0.32, expand: 1 });
    const core = MeshBuilder.CreateSphere(
      'blast-core',
      { diameter: Math.min(radius, 0.7), segments: 8 },
      this.scene,
    );
    core.position.copyFrom(ring.position);
    core.material = this.impact;
    core.isPickable = false;
    this.effects.push({ mesh: core, life: 0.15, total: 0.15, expand: 1.6 });
  }

  shot(shot: ShotView): void {
    if (shot.kind === 'bazooka') return;
    const length = Math.hypot(
      shot.to.x - shot.from.x,
      shot.to.y - shot.from.y,
      shot.to.z - shot.from.z,
    );
    const life = shot.kind === 'photon' ? 1 : shot.kind === 'flamethrower' ? 0.2 : 0.045;
    if (length > 0.01) {
      const streak =
        shot.kind === 'flamethrower'
          ? MeshBuilder.CreateGround('flame-burst', { width: 1.05, height: length }, this.scene)
          : shot.kind === 'photon'
            ? MeshBuilder.CreateGround('shot-tracer', { width: 0.65, height: length }, this.scene)
            : MeshBuilder.CreateBox(
                'shot-tracer',
                {
                  width: 0.015,
                  height: 0.015,
                  depth: length,
                },
                this.scene,
              );
      streak.isPickable = false;
      streak.position.set(
        (shot.from.x + shot.to.x) / 2,
        (shot.from.z + shot.to.z) / 2,
        (shot.from.y + shot.to.y) / 2,
      );
      streak.lookAt(new Vector3(shot.to.x, shot.to.z, shot.to.y));
      let trace = this.tracer;
      if (shot.kind && shot.kind !== 'photon' && ARSENAL_COLORS[shot.kind]) {
        const key = `trace-${shot.kind}`;
        let colored = this.objectMaterials.get(key);
        if (!colored) {
          colored = this.material(key, ARSENAL_COLORS[shot.kind]!, 1);
          this.objectMaterials.set(key, colored);
        }
        trace = colored;
      }
      streak.material =
        shot.kind === 'photon'
          ? this.photon
          : shot.kind === 'flamethrower'
            ? this.flameBurst
            : trace;
      this.effects.push({ mesh: streak, life, total: life });
    }
    const spark = MeshBuilder.CreateSphere(
      'impact',
      { diameter: shot.killed ? 0.36 : 0.08, segments: 5 },
      this.scene,
    );
    spark.position.set(shot.to.x, shot.to.z, shot.to.y);
    spark.material = this.impact;
    this.effects.push({ mesh: spark, life: 0.12, total: 0.12 });
  }

  reset(): void {
    for (const effect of this.effects) effect.mesh.dispose();
    this.effects = [];
  }

  render(dt: number): void {
    this.effects = this.effects.filter((effect) => {
      effect.life -= dt;
      if (effect.life <= 0) {
        effect.mesh.dispose();
        return false;
      }
      effect.mesh.visibility = effect.life / effect.total;
      if (effect.expand)
        effect.mesh.scaling.setAll(0.25 + (1 - effect.life / effect.total) * effect.expand);
      return true;
    });
  }
}
