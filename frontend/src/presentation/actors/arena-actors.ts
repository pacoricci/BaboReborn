import { createNameLabel } from './name-label';
import { createTeamMarker } from './team-marker';
import { TEAM_COLORS } from './team-style';
// Scene-owned actor meshes, equipment animation and per-actor resources.
import { animateKnifeModel } from './knife-animation';
import type { ModelNode } from '../assets/model-assets';
import { EquipmentMotion } from './equipment-motion';
import { createArsenal, visualMuzzle } from './arsenal';
import type { PrimaryModel } from './arsenal';
import { FresnelParameters } from '@babylonjs/core/Materials/fresnelParameters';
import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Rolling } from './rolling';
import { DEFAULT_APPEARANCE, TARGET_APPEARANCE } from '../../player/appearance';
import type { Appearance } from '../../player/appearance';
import type { VisualKit } from '../assets/visual-kit';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { SMG_MUZZLE } from '../../gameconfig/tuning';
import type { ArenaView, PlayerView, ShotView } from '../view';

interface Actor {
  label?: ReturnType<typeof createNameLabel>;
  marker: Mesh;
  teamSymbols: { blue: Mesh; red: Mesh };
  root: TransformNode;
  aim: TransformNode;
  rolling: Rolling;
  motion: EquipmentMotion;
  skin: StandardMaterial;
  ball: ModelNode;
  bar: Mesh | undefined;
  muzzle?: Mesh;
  arsenal?: Map<string, PrimaryModel>;
  weaponMount?: ModelNode;
  shield?: Mesh;
  shieldRing?: Mesh;
  knives?: ModelNode;
  presentedAt?: number;
  flashTime?: number;
  ownedMaterials: StandardMaterial[];
}
export class ArenaActors {
  private player: Actor;
  private actors = new Map<number, Actor>();
  private presentationFrame = 0;
  private muzzleTime = 0;
  private hitMaterial: StandardMaterial;

  constructor(
    private scene: Scene,
    private kit: Pick<VisualKit, 'skin' | 'models' | 'setSkin' | 'flash'>,
    private castShadow: (mesh: AbstractMesh) => void,
  ) {
    this.player = this.actor('you', true);
    this.hitMaterial = this.material('hit', '#fff0c9', 0.6);
  }

  private material(name: string, hex: string, emissive = 0): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = Color3.FromHexString(hex);
    material.specularColor = new Color3(0.07, 0.07, 0.06);
    if (emissive) material.emissiveColor = material.diffuseColor.scale(emissive);
    return material;
  }

  private actor(name: string, armed: boolean, showHealth = !armed): Actor {
    const ownedMaterials: StandardMaterial[] = [];
    const ownMaterial = (name: string, hex: string, emissive = 0) => {
      const result = this.material(name, hex, emissive);
      ownedMaterials.push(result);
      return result;
    };
    const root = new TransformNode(name, this.scene);
    const teamMarker = createTeamMarker(this.scene, ownMaterial);
    const marker = teamMarker.ring;
    const teamSymbols = { blue: teamMarker.blue, red: teamMarker.red };
    marker.parent = root;
    marker.position.y = 0.025;
    marker.setEnabled(false);
    const aim = new TransformNode(`${name}-aim`, this.scene);
    aim.parent = root;
    const rolling = new Rolling();
    const motion = new EquipmentMotion();
    const material = this.kit.skin(name);
    root.onDisposeObservable.addOnce(() => material.dispose(false, true));
    const ball = this.kit.models.create('babo', root, {
      material,
      configureMesh: (mesh) => {
        this.castShadow(mesh);
        mesh.receiveShadows = true;
      },
    });
    ball.rotationQuaternion = Quaternion.Identity();
    ball.position.y = 0.25;
    let bar: Mesh | undefined;
    if (showHealth) {
      bar = MeshBuilder.CreateBox(
        `${name}-hp`,
        { width: 0.48, height: 0.015, depth: 0.035 },
        this.scene,
      );
      bar.position.set(0, 0.025, 0.4);
      bar.parent = root;
      bar.material = ownMaterial(`${name}-health`, '#84d296', 0.3);
      const track = MeshBuilder.CreateBox(
        `${name}-hp-track`,
        { width: 0.52, height: 0.012, depth: 0.065 },
        this.scene,
      );
      track.parent = root;
      track.position.set(0, 0.015, 0.4);
      track.material = ownMaterial(`${name}-hp-track`, '#172326');
      track.isPickable = false;
    }
    if (armed) {
      const weaponMount = this.kit.models.create('weapon-mount', aim);
      const arsenal = createArsenal(this.kit.models, aim);
      const muzzle = MeshBuilder.CreateGround(
        'muzzle-flash',
        { width: 0.32, height: 0.48 },
        this.scene,
      );
      muzzle.position.set(SMG_MUZZLE.right, SMG_MUZZLE.height, SMG_MUZZLE.forward + 0.12);
      muzzle.parent = aim;
      muzzle.material = this.kit.flash;
      muzzle.isPickable = false;
      muzzle.setEnabled(false);
      const shield = MeshBuilder.CreateSphere(
        'shield',
        { diameter: 0.85, segments: 16 },
        this.scene,
      );
      shield.parent = aim;
      shield.position.y = 0.25;
      const shieldMaterial = ownMaterial('shield-glow', '#92e5ff', 0.7);
      shieldMaterial.alpha = 0.42;
      shieldMaterial.opacityFresnelParameters = new FresnelParameters();
      shieldMaterial.opacityFresnelParameters.leftColor = Color3.White();
      shieldMaterial.opacityFresnelParameters.rightColor = new Color3(0.06, 0.06, 0.06);
      shieldMaterial.opacityFresnelParameters.power = 2;
      shield.material = shieldMaterial;
      shield.setEnabled(false);
      const shieldRing = MeshBuilder.CreateTorus(
        'shield-ring',
        { diameter: 0.75, thickness: 0.025, tessellation: 32 },
        this.scene,
      );
      shieldRing.parent = aim;
      shieldRing.position.y = 0.035;
      shieldRing.isPickable = false;
      shieldRing.material = ownMaterial('shield-rim', '#75dfff', 0.7);
      shieldRing.setEnabled(false);
      const knives = this.kit.models.create('knives', aim);
      knives.setEnabled(false);
      return {
        marker,
        teamSymbols,
        root,
        aim,
        rolling,
        motion,
        skin: material,
        ball,
        muzzle,
        arsenal,
        weaponMount,
        shield,
        shieldRing,
        knives,
        bar,
        ownedMaterials,
      };
    }
    return {
      marker,
      teamSymbols,
      root,
      aim,
      rolling,
      motion,
      skin: material,
      ball,
      bar,
      ownedMaterials,
    };
  }

  private animateKnives(actor: Actor, amount: number): void {
    if (!actor.knives) return;
    animateKnifeModel(actor.knives, amount);
  }

  snapshot() {
    const read = (actor: Actor) => ({
      name: actor.root.name,
      visible: actor.root.isEnabled(),
      position: { x: actor.root.position.x, y: actor.root.position.z },
      aim: actor.aim.rotation.y,
      rotation: actor.ball.rotationQuaternion!.asArray(),
      textured: actor.skin.diffuseTexture !== null,
      motion: {
        rotor: actor.motion.rotor,
        rotorSpeed: actor.motion.rotorSpeed,
        kick: actor.motion.kick,
        charge: actor.motion.charge,
        reloadTilt: actor.motion.reloadTilt,
        shield: actor.motion.shield,
      },
    });
    return {
      player: read(this.player),
      actors: Array.from(this.actors.values(), read),
    };
  }
  shot(shot: ShotView, actorID?: number): void {
    // Mini Bot shots belong to the device; never kick or flash its owner's primary.
    const shooter =
      shot.kind === 'minibot'
        ? undefined
        : actorID === undefined
          ? this.player
          : this.actors.get(actorID);
    shooter?.motion.shot();
    if (shooter?.muzzle) {
      shooter.aim.computeWorldMatrix(true);
      const local = Vector3.TransformCoordinates(
        new Vector3(shot.from.x, shot.from.z, shot.from.y),
        Matrix.Invert(shooter.aim.getWorldMatrix()),
      );
      shooter.muzzle.position.copyFrom(local);
      shooter.muzzle.position.z += 0.12;
      if (actorID === undefined) this.muzzleTime = 0.045;
      else shooter.flashTime = 0.045;
    }
  }

  reset(): void {
    this.player.rolling.reset();
    this.player.motion.reset();
    this.muzzleTime = 0;
  }

  private equipment(
    actor: Actor,
    body: Readonly<PlayerView> | ArenaView['actors'][number],
    dt: number,
  ): void {
    const primary = body.primary;
    const motion = actor.motion;
    motion.update(
      primary ?? 'smg',
      body.life,
      body.visible !== false,
      body.weapon,
      body.shield ?? false,
      dt,
    );
    if (actor.shield) {
      actor.shield.setEnabled(motion.shield > 0);
      actor.shield.visibility = motion.shield;
      actor.shield.scaling.setAll(0.82 + 0.18 * motion.shield);
    }
    if (actor.shieldRing) {
      actor.shieldRing.setEnabled(motion.shield > 0);
      actor.shieldRing.visibility = motion.shield * 0.8;
      actor.shieldRing.scaling.setAll(0.65 + motion.shield * 0.35);
    }
    // The fitted mount follows aim but stays seated while the weapon recoils/reloads.
    for (const [kind, part] of actor.weaponMount?.parts ?? [])
      part.setEnabled(kind === (primary ?? 'smg'));
    const shotgun = primary === 'shotgun';
    const muzzle = visualMuzzle(primary);
    if (actor.muzzle && (actor === this.player ? this.muzzleTime : (actor.flashTime ?? 0)) <= 0)
      actor.muzzle.position.set(
        shotgun ? 0.07929281234741212 : (muzzle?.muzzleRight ?? SMG_MUZZLE.right),
        muzzle?.muzzleHeight ?? SMG_MUZZLE.height,
        (shotgun ? 0.5478733825683594 : (muzzle?.muzzleForward ?? SMG_MUZZLE.forward)) + 0.12,
      );
    for (const [kind, node] of actor.arsenal ?? []) {
      node.setEnabled(kind === (primary ?? 'smg'));
      if (kind !== (primary ?? 'smg')) continue;
      node.position.z = -motion.kick;
      node.rotation.x = motion.reloadTilt;
      const rotor = node.parts.get('rotor'),
        charge = node.parts.get('charge');
      if (rotor) rotor.rotation.z = motion.rotor;
      if (charge) {
        charge.scaling.setAll(0.8 + motion.charge * 0.4);
        for (const mesh of node.partMeshes.get('charge')!)
          mesh.visibility = 0.2 + motion.charge * 0.8;
      }
    }
  }

  private presentBody(
    actor: Actor,
    body: {
      nickname?: string | undefined;
      nicknameColors?: string | undefined;
      marker?: string | undefined;
      x: number;
      y: number;
      angle?: number;
      life?: number | undefined;
      visible?: boolean;
      appearance?: Appearance | undefined;
    },
    fallback: Appearance,
    dt: number,
  ): void {
    if (body.nickname && !actor.label) actor.label = createNameLabel(this.scene, actor.root);
    actor.label?.update(body.nickname ?? '', body.nicknameColors);
    actor.marker.setEnabled(!!body.marker);
    actor.teamSymbols.blue.setEnabled(body.marker === TEAM_COLORS.blue);
    actor.teamSymbols.red.setEnabled(body.marker === TEAM_COLORS.red);
    if (body.marker) {
      const material = actor.marker.material as StandardMaterial;
      material.diffuseColor.copyFrom(Color3.FromHexString(body.marker));
      material.emissiveColor.copyFrom(material.diffuseColor.scale(0.35));
    }
    actor.aim.rotation.y = Math.PI / 2 - (body.angle ?? 0);
    actor.rolling.update(body.x, body.y, body.life, body.visible !== false, dt);
    const q = actor.rolling;
    actor.ball.rotationQuaternion!.set(q.x, q.y, q.z, q.w);
    this.kit.setSkin(actor.skin, body.appearance ?? fallback);
  }

  render(view: ArenaView, dt: number, rollDt: number): void {
    const displayed = view.player;
    this.equipment(this.player, displayed, dt);
    this.animateKnives(this.player, displayed.knives ?? 0);
    this.player.root.setEnabled(displayed.visible !== false);
    this.player.root.position.set(displayed.x, 0, displayed.y);
    this.presentBody(this.player, displayed, DEFAULT_APPEARANCE, rollDt);
    this.muzzleTime = Math.max(0, this.muzzleTime - dt);
    this.player.muzzle?.setEnabled(this.muzzleTime > 0);
    this.presentationFrame++;
    for (const body of view.actors) {
      let actor = this.actors.get(body.id);
      if (!actor) {
        actor = this.actor(`actor-${body.id}`, body.angle !== undefined, true);
        this.actors.set(body.id, actor);
      }
      this.equipment(actor, body, dt);
      this.animateKnives(actor, body.knives ?? 0);
      actor.presentedAt = this.presentationFrame;
      actor.flashTime = Math.max(0, (actor.flashTime ?? 0) - dt);
      actor.muzzle?.setEnabled(actor.flashTime > 0);
      actor.root.setEnabled(body.visible);
      actor.root.position.set(body.x, 0, body.y);
      this.presentBody(actor, body, TARGET_APPEARANCE, rollDt);
      actor.ball.material = body.hitFlash ? this.hitMaterial : actor.skin;
      if (actor.bar) {
        actor.bar.scaling.x = body.healthFraction;
        const healthMaterial = actor.bar.material as StandardMaterial;
        healthMaterial.diffuseColor.set(
          body.healthFraction < 0.3 ? 1 : 0.45,
          body.healthFraction < 0.3 ? 0.35 : 0.9,
          0.4,
        );
      }
    }
    for (const [id, actor] of this.actors) {
      if (actor.presentedAt !== this.presentationFrame) {
        actor.root.dispose();
        for (const material of actor.ownedMaterials) material.dispose();
        this.actors.delete(id);
      }
    }
  }
}
