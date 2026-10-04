import { animateKnifeModel } from '../../../frontend/src/presentation/actors/knife-animation';
import { knifeExtension } from '../../../frontend/src/presentation/actors/knife-state';
import { wallSurface } from '../../../frontend/src/presentation/environment/wall-surface';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ArenaRenderer } from '../../../frontend/src/presentation/scene/renderer';
import type { ModelNode } from '../../../frontend/src/presentation/assets/model-assets';
import { MODEL_DEFINITIONS } from '../../../frontend/src/presentation/assets/model-catalog';
import { PRIMARY_MODELS, visualMuzzle } from '../../../frontend/src/presentation/actors/arsenal';
import { EquipmentMotion } from '../../../frontend/src/presentation/actors/equipment-motion';
import type { ArenaView, ObjectView, PlayerView } from '../../../frontend/src/presentation/view';
import { DEFAULT_APPEARANCE } from '../../../frontend/src/player/appearance';
import type { Appearance } from '../../../frontend/src/player/appearance';
import { SMG_MUZZLE } from '../../../frontend/src/gameconfig/tuning';

export interface PreviewSettings {
  id: string;
  mode: 'model' | 'game';
  time: number;
  animated: boolean;
  yaw: number;
  elevation: number;
  zoom: number;
  turn: boolean;
  appearance: Appearance;
}
export const defaults = (): PreviewSettings => ({
  id: 'knives',
  mode: 'model',
  time: 0,
  animated: false,
  yaw: -35,
  elevation: 35,
  zoom: 1,
  turn: false,
  appearance: structuredClone(DEFAULT_APPEARANCE),
});

// This fixture supplies visual states only. Flight paths and the three-second timeline
// are illustrative; the server remains the source of combat rules and timing.
export class PreviewStage {
  readonly renderer: ArenaRenderer;
  private model: ModelNode | undefined;
  private root: TransformNode;
  private center = Vector3.Zero();
  private extent = 1;
  private current = '';
  private settings = defaults();
  private motion = new EquipmentMotion();
  private clockedShaders = new WeakSet<ShaderMaterial>();
  private lastTime = -1;
  private lastEvent = '';
  private resizeObserver: ResizeObserver;
  constructor(readonly canvas: HTMLCanvasElement) {
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false });
    const initial: ArenaView = {
      player: { x: 8, y: 8, angle: Math.PI / 2, visible: false },
      actors: [],
    };
    this.renderer = new ArenaRenderer(
      canvas,
      document.createElement('canvas'),
      {
        schema: 1,
        theme: 'classic',
        id: 'workshop',
        name: 'Asset workshop',
        author: 'Development tools',
        width: 16,
        height: 16,
        spawns: [],
        walls: [],
      },
      initial,
      { paths: [] },
      engine,
    );
    this.root = new TransformNode('inspection-root', this.renderer.scene);
    this.root.position.set(8, 0, 8);
    this.renderer.camera.unfreezeProjectionMatrix();
    // Override the camera after the game adapter has positioned it. No production
    // camera policy is changed by this developer-only orbit camera.
    this.renderer.scene.onBeforeRenderObservable.add(() => {
      const s = this.settings,
        camera = this.renderer.camera;
      camera.upVector.set(0, 1, 0);
      camera.minZ = 0.01;
      const target = new Vector3(8, 0.2, 8);
      if (s.mode === 'game') {
        camera.upVector.set(0, 0, 1);
        camera.position.set(8, 3 / s.zoom, 8);
      } else {
        const aspect = Math.max(0.1, this.canvas.width / this.canvas.height);
        const fov = Math.min(camera.fov, 2 * Math.atan(Math.tan(camera.fov / 2) * aspect));
        const extent =
          s.animated && ['grenade', 'molotov', 'rocket'].includes(s.id)
            ? Math.max(3.2, this.extent)
            : this.extent;
        const distance = (extent * 0.55) / Math.sin(fov / 2) / s.zoom;
        const yaw = (s.yaw * Math.PI) / 180 + (s.turn ? (s.time / 3) * Math.PI * 2 : 0);
        const pitch = (s.elevation * Math.PI) / 180;
        camera.position.set(
          8 + Math.sin(yaw) * Math.cos(pitch) * distance,
          target.y + Math.sin(pitch) * distance,
          8 + Math.cos(yaw) * Math.cos(pitch) * distance,
        );
      }
      camera.setTarget(target);
      // Keep analytic shaders on the same paused/scrubbable preview clock.
      for (const material of this.renderer.scene.materials)
        if (material instanceof ShaderMaterial) material.setFloat('time', s.time);
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
  }
  resize() {
    this.renderer.engine.resize();
  }
  get status() {
    return this.renderer.kit.status;
  }
  async ready() {
    await this.renderer.kit.models.ready;
  }
  private select(id: string) {
    this.model?.dispose();
    this.model = undefined;
    this.current = id;
    this.lastEvent = '';
    this.lastTime = -1;
    this.motion.reset();
    this.extent = ['explosion', 'tracer', 'flash'].includes(id)
      ? 4
      : ['shield', 'terrain'].includes(id)
        ? 2
        : 1.5;
    if (id.startsWith('flag-')) this.extent = 2.4;
    if (id === 'terrain') this.extent = 23;
    if (id === 'flash') this.extent = 1.3;
    if (id === 'explosion') this.extent = 3;
    if (MODEL_DEFINITIONS[id] && id !== 'babo') {
      this.root.scaling.setAll(1);
      this.root.rotation.setAll(0);
      this.model = this.renderer.kit.models.create(id, this.root, {
        ...(id === 'wall'
          ? {
              material: this.renderer.kit.wallMaterials,
              configureMesh: (mesh) => {
                if (mesh instanceof Mesh)
                  wallSurface(
                    mesh,
                    { x: 0, y: 0, w: 1, h: 1, height: 1 },
                    this.renderer.kit.wallMaterials,
                  );
              },
            }
          : {}),
        onReady: (node) => {
          node.computeWorldMatrix(true);
          const bounds = node.getHierarchyBoundingVectors(true);
          this.center = bounds.min.add(bounds.max).scale(0.5).subtract(this.root.position);
          this.extent = Math.max(0.25, bounds.max.subtract(bounds.min).length());

          node.position.subtractInPlace(this.center);
          node.position.y += 0.2;
        },
      });
    }
  }
  render(s: PreviewSettings) {
    this.settings = s;
    if (s.id !== this.current) this.select(s.id);
    const r = this.renderer,
      t = s.time,
      phase = t / 3;
    const rewound = t < this.lastTime;
    const dt = this.lastTime < 0 || rewound ? 0 : Math.min(0.1, t - this.lastTime);
    const primary = PRIMARY_MODELS.includes(s.id);
    const isolated = s.mode === 'model';
    const teamIndicator = s.id.startsWith('team-');
    this.root.setEnabled(isolated || s.id === 'wall');
    this.model?.setEnabled(isolated || s.id === 'wall');
    r.scene.clearColor = Color4.FromHexString(isolated ? '#20252dff' : '#1c2925ff');
    r.scene.getMeshByName('floor')?.setEnabled(!isolated || s.id === 'terrain');
    r.scene.getMeshByName('terrain-wear')?.setEnabled(!isolated || s.id === 'terrain');

    const p: PlayerView = {
      x: 8,
      y: 8,
      angle: Math.PI / 2,
      appearance: s.appearance,
      marker: teamIndicator ? (s.id.endsWith('blue') ? '#55aaff' : '#ff665e') : undefined,
      visible:
        teamIndicator ||
        (!isolated &&
          (primary ||
            ['knives', 'shield', 'babo', 'weapon-mount', 'flash', 'tracer', 'flame'].includes(
              s.id,
            ))) ||
        ['babo', 'shield', 'flash'].includes(s.id),
      primary: primary ? s.id : 'smg',
      knives: s.id === 'knives' ? (s.animated ? knifeExtension(1 - (t % 3), 1) : 1) : 0,
      shield: s.id === 'shield' && (!s.animated || phase < 0.65),
      weapon: {
        shotAge: s.animated ? t % 0.6 : Infinity,
        charge: s.animated ? phase : 0.7,
        reload: s.animated ? phase : 0,
      },
    };
    if ((s.id === 'babo' || s.id === 'flame') && s.animated) p.x += Math.sin(t * 2) * 0.3;
    if (this.model) {
      this.root.rotation.y = 0;
      this.root.scaling.setAll(1);
      this.motion.update(s.id, 1, true, p.weapon, false, dt);
      this.model.rotation.x = this.motion.reloadTilt;
      if (primary) this.model.position.z = -this.center.z - this.motion.kick;
      if (s.id === 'weapon-mount')
        for (const [kind, part] of this.model.parts) part.setEnabled(kind === 'smg');
      const rotor = this.model.parts.get('rotor'),
        charge = this.model.parts.get('charge');
      if (rotor) rotor.rotation.z = s.animated ? t * 18 : 0;
      if (charge) {
        charge.scaling.setAll(0.8 + (p.weapon?.charge ?? 0) * 0.4);
        for (const mesh of this.model.partMeshes.get('charge') ?? [])
          mesh.visibility = 0.2 + (p.weapon?.charge ?? 0) * 0.8;
      }
      if (s.id === 'knives') {
        const amount = p.knives ?? 1;
        this.root.setEnabled(amount > 0.001 && isolated);
        animateKnifeModel(this.model, amount);
      }
      const turret = this.model.parts.get('turret-head');
      if (turret) turret.rotation.y = s.animated ? Math.sin(t * 2) : 0;
    }
    const objects: ObjectView[] = [];
    // Reuse CTF world art instead of maintaining separate workshop geometry.
    if (!isolated && (s.id.startsWith('flag-') || s.id.startsWith('base-')))
      objects.push({ id: 5, kind: s.id, x: 8, y: 8, z: 0.03 });
    const devices = ['minibot', 'grenade', 'molotov', 'health', 'rocket'];
    // Animated devices use WorldArt so exhaust and flash stay identical.
    if (devices.includes(s.id) && (!isolated || s.animated)) {
      this.model?.setEnabled(false);
      const flying = s.animated && ['grenade', 'molotov', 'rocket'].includes(s.id);
      if (!flying || phase < 0.7)
        objects.push({
          id: 1,
          kind: s.id,
          x: flying ? 7 + phase / 0.7 : 8,
          y: 8,
          z: flying ? 0.1 + Math.sin((phase / 0.7) * Math.PI) * 0.55 : 0.08,
          angle: flying ? 0 : Math.PI / 2,
          ...(flying && (s.id === 'grenade' || s.id === 'molotov')
            ? { throwMotion: { age: t, moving: true } }
            : {}),
          turret: {
            angle: s.animated ? Math.PI / 2 + Math.sin(t * 2) : Math.PI / 2,
            shotAge: s.animated ? t % 0.4 : Infinity,
          },
        });
    }
    if (s.id === 'flame' || (s.id === 'molotov' && s.animated && phase >= 0.7))
      objects.push({ id: 2, kind: 'flame', x: s.id === 'flame' ? p.x : 8, y: 8, z: 0.03 });
    if (s.id === 'bazooka' && s.animated && !isolated)
      objects.push({
        id: 4,
        kind: 'rocket',
        x: 8,
        y: 8.4 + (t % 0.6) * 2,
        z: 0.3,
        angle: Math.PI / 2,
      });
    if (s.id === 'pickup') objects.push({ id: 3, kind: 'smg', x: 8, y: 8, z: 0.08 });
    const view: ArenaView = {
      player: p,
      objects,
      actors:
        s.id === 'health-bar'
          ? [
              {
                id: 2,
                x: 8,
                y: 8,
                angle: 0,
                visible: true,
                healthFraction: s.animated ? 1 - phase : 0.6,
                hitFlash: false,
              },
            ]
          : [],
    };
    // Scrubbing expires old transient meshes, then reconstructs the event at the
    // requested age. Regular playback uses normal effect lifetime integration.
    const seeking = rewound || Math.abs(t - this.lastTime) > 0.15;
    if (seeking) {
      r.render(view, { x: 8, y: 10 }, 10, false);
      this.lastEvent = '';
    }
    const blast =
      s.id === 'explosion' || (s.animated && ['grenade', 'rocket'].includes(s.id) && phase >= 0.7);
    const firing = ['tracer', 'flash'].includes(s.id) || (primary && s.animated && !isolated);
    const event = blast
      ? `blast-${s.id === 'explosion' ? Math.floor(t / 1.2) : 0}`
      : firing
        ? `shot-${Math.floor(t / 0.6)}`
        : '';
    if (event && event !== this.lastEvent) {
      this.lastEvent = event;
      if (blast) r.explosion({ x: 8, y: 8, z: 0.08 }, 1.2);
      else {
        const muzzle = visualMuzzle(p.primary);
        const x = 8 + (muzzle?.muzzleRight ?? SMG_MUZZLE.right);
        const y = 8 + (muzzle?.muzzleForward ?? SMG_MUZZLE.forward);
        r.shot({
          kind: s.id === 'tracer' ? 'photon' : p.primary!,
          from: { x, y, z: 0.3 },
          to: { x, y: y + (s.id === 'flash' ? 0 : 1.4), z: 0.3 },
          killed: false,
        });
      }
    }
    const eventAge = blast ? (s.id === 'explosion' ? t % 1.2 : Math.max(0, t - 2.1)) : t % 0.6;
    r.render(
      view,
      { x: 8, y: 10 },
      seeking && event && s.animated
        ? eventAge
        : !s.animated && this.lastTime < 0
          ? s.id === 'explosion'
            ? 0.12
            : 0.01
          : dt,
      false,
    );
    if (s.id === 'shield' && !s.animated && this.lastTime < 0)
      r.render(view, { x: 8, y: 10 }, 0.1, false);
    // World fire materials may be created after our scene observer. Override the
    // effect at bind time too, so their own wall-clock observers cannot unpause it.
    for (const material of r.scene.materials) {
      if (material instanceof ShaderMaterial && !this.clockedShaders.has(material)) {
        this.clockedShaders.add(material);
        material.onBindObservable.add(() =>
          material.getEffect()?.setFloat('time', this.settings.time),
        );
      }
    }
    this.lastTime = t;
  }
  image() {
    return this.canvas.toDataURL('image/png');
  }
  dispose() {
    this.resizeObserver.disconnect();
    this.renderer.scene.dispose();
    this.renderer.engine.dispose();
  }
}
