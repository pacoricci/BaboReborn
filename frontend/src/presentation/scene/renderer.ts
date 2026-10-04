import { ArenaObjects } from '../environment/arena-objects';
import { FloorDecals } from '../environment/floor-decals';
import { ArenaActors } from '../actors/arena-actors';
import { BloodEffects } from '../effects/blood';
import { ArenaEffects } from '../effects/arena-effects';
import { drawMinimap } from '../ui/minimap';
import { loadTerrainArt } from '../environment/terrain-layout';
import { themeByID } from '../../content/types';
import type { Catalog } from '../../content/types';
import { currentContent } from '../../content/runtime';
import { terrain } from '../environment/terrain';
import type { TerrainArt } from '../environment/terrain';
// Babylon presentation consumes an arena and visual data, without practice lifecycle state.
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { VisualKit } from '../assets/visual-kit';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import '@babylonjs/core/Culling/ray';
import { CAMERA, followCamera } from '../camera';
import { clamp } from '../../core/geometry';
import type { Vec2, Vec3 } from '../../core/geometry';
import type { ArenaMap } from '../../maps/types';
import type { ArenaView, PlayerView, ShotView } from '../view';

export function createArenaEngine(canvas: HTMLCanvasElement): Engine {
  const engine = new Engine(
    canvas,
    true,
    { stencil: false, preserveDrawingBuffer: false, disableWebGL2Support: false },
    false,
  );
  if (engine.webGLVersion !== 2) {
    engine.dispose();
    throw new Error('WebGL 2 is required. Enable graphics acceleration in Chrome and reload.');
  }
  return engine;
}

export class ArenaRenderer {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  readonly kit: VisualKit;
  readonly decals: FloorDecals | undefined;
  reducedEffects = false;
  private resolutionScale = 1;
  private shadows: ShadowGenerator;
  private bodies: ArenaActors;
  private effects: ArenaEffects;
  private bloodEffects: BloodEffects;
  private lastRenderedAt: number | undefined;
  private miniContext: CanvasRenderingContext2D;
  private cameraPosition: Vec2;
  private objects: ArenaObjects;

  constructor(
    private canvas: HTMLCanvasElement,
    minimap: HTMLCanvasElement,
    private arena: ArenaMap,
    view: ArenaView,
    terrainArt?: TerrainArt,
    engine?: Engine,
    content: Catalog = currentContent(),
    environment = true,
  ) {
    if (engine && engine.webGLVersion !== 2)
      throw new Error('WebGL 2 is required. Enable graphics acceleration in Chrome and reload.');
    this.engine = engine ?? createArenaEngine(canvas);
    this.scene = new Scene(this.engine);
    const scenario = themeByID(content, arena.theme);
    this.scene.clearColor = Color4.FromHexString(`${scenario.background}ff`);
    this.scene.skipPointerMovePicking = true;
    this.scene.skipPointerDownPicking = true;
    this.scene.skipPointerUpPicking = true;
    this.cameraPosition = { x: view.player.x, y: view.player.y };
    this.camera = new FreeCamera(
      'overhead',
      new Vector3(this.cameraPosition.x, 7, this.cameraPosition.y),
      this.scene,
    );
    this.camera.upVector = new Vector3(0, 0, 1);
    this.camera.fov = CAMERA.verticalFovRadians;
    this.camera.minZ = CAMERA.near;
    this.camera.maxZ = CAMERA.far;
    this.camera.freezeProjectionMatrix(
      Matrix.PerspectiveFovLH(CAMERA.verticalFovRadians, CAMERA.aspect, CAMERA.near, CAMERA.far),
    );
    this.camera.setTarget(new Vector3(this.cameraPosition.x, 0, this.cameraPosition.y));
    this.camera.inputs.clear();
    const ambient = new HemisphericLight('sky', new Vector3(0, 1, 0), this.scene);
    ambient.intensity = 0.65;
    ambient.groundColor = Color3.FromHexString(scenario.groundLight);
    const sunlight = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.7), this.scene);
    sunlight.intensity = 0.75;
    sunlight.position.set(arena.width / 2, 24, arena.height / 2);
    sunlight.shadowMinZ = 1;
    sunlight.shadowMaxZ = 80;
    this.shadows = new ShadowGenerator(1024, sunlight);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_LOW;
    this.shadows.bias = 0.002;
    this.shadows.normalBias = 0.015;
    this.shadows.setDarkness(0.22);
    this.kit = new VisualKit(
      this.scene,
      (mesh) => this.shadows.addShadowCaster(mesh),
      arena.theme,
      content,
    );
    this.objects = new ArenaObjects(this.scene, this.kit);
    if (environment) this.buildMap(terrainArt);
    this.decals = environment
      ? new FloorDecals(this.scene, arena, content, this.kit.status)
      : undefined;
    if (environment && !terrainArt && scenario.outdoorWear) {
      this.kit.status['terrain-layouts.json'] = 'loading';
      void loadTerrainArt(arena)
        .then((art) => {
          if (this.scene.isDisposed) return;
          if (art) {
            this.scene.getMeshByName('floor')?.dispose();
            this.scene.getMeshByName('terrain-wear')?.dispose();
            terrain(
              this.scene,
              arena.width,
              {
                terrain: this.kit.terrain,
                earth: this.kit.earth,
                theme: themeByID(this.kit.content, this.arena.theme),
              },
              art,
              arena.height,
              arena.walls,
            );
          }
          this.kit.status['terrain-layouts.json'] = 'ready';
        })
        .catch(() => {
          if (!this.scene.isDisposed) this.kit.status['terrain-layouts.json'] = 'failed';
        });
    }
    this.bodies = new ArenaActors(this.scene, this.kit, (mesh) =>
      this.shadows.addShadowCaster(mesh),
    );
    this.effects = new ArenaEffects(this.scene);
    this.bloodEffects = new BloodEffects(this.scene);
    this.miniContext = minimap.getContext('2d')!;
    this.resize();
    this.render(view, { x: view.player.x, y: view.player.y + 1 }, 0, false);
  }

  private buildMap(art?: TerrainArt): void {
    terrain(
      this.scene,
      this.arena.width,
      {
        terrain: this.kit.terrain,
        earth: this.kit.earth,
        theme: themeByID(this.kit.content, this.arena.theme),
      },
      art,
      this.arena.height,
      this.arena.walls,
    );
    for (const [id, wall] of this.arena.walls.entries()) this.kit.wall(wall, id);
  }

  appearanceSnapshot() {
    return {
      ...this.bodies.snapshot(),
      devices: this.objects.snapshot(),
    };
  }

  resize(): void {
    // Cap actual pixels at 1080p, retaining the canvas aspect ratio.
    const scale = Math.min(1, 1920 / this.canvas.clientWidth, 1080 / this.canvas.clientHeight);
    this.engine.setSize(
      Math.round(this.canvas.clientWidth * scale * this.resolutionScale),
      Math.round(this.canvas.clientHeight * scale * this.resolutionScale),
    );
  }

  aim(clientX: number, clientY: number): Vec2 {
    const bounds = this.canvas.getBoundingClientRect();
    const ray = this.scene.createPickingRay(
      ((clientX - bounds.left) * this.engine.getRenderWidth()) / bounds.width,
      ((clientY - bounds.top) * this.engine.getRenderHeight()) / bounds.height,
      Matrix.Identity(),
      this.camera,
    );
    const distance = -ray.origin.y / ray.direction.y;
    return {
      x: clamp(ray.origin.x + ray.direction.x * distance, 0, this.arena.width),
      y: clamp(ray.origin.z + ray.direction.z * distance, 0, this.arena.height),
    };
  }

  shot(shot: ShotView, actorID?: number): void {
    this.bodies.shot(shot, actorID);
    this.effects.shot(shot);
  }

  blood(position: Vec2, damage: number): void {
    if (this.reducedEffects) return;
    this.bloodEffects.hit(position, damage);
  }

  clearBlood(): void {
    this.bloodEffects.reset();
  }

  explosion(position: Vec3, radius: number): void {
    this.effects.explosion(position, radius);
  }

  reset(player: Readonly<PlayerView>): void {
    this.bodies.reset();
    this.cameraPosition.x = player.x;
    this.cameraPosition.y = player.y;
    this.effects.reset();
    this.clearBlood();
  }

  setQuality(quality: 'low' | 'medium' | 'high'): void {
    this.resolutionScale = quality === 'low' ? 0.5 : quality === 'medium' ? 0.75 : 1;
    this.resize();
    this.scene.shadowsEnabled = quality !== 'low';
  }

  render(view: ArenaView, aim: Vec2, dt: number, playing: boolean): void {
    const now = performance.now();
    const rollDt = Math.max(
      dt,
      this.lastRenderedAt === undefined ? 0 : (now - this.lastRenderedAt) / 1000,
    );
    this.lastRenderedAt = now;
    const displayed = view.player;
    if (playing && !view.camera)
      followCamera(this.cameraPosition, displayed, aim, this.arena.width, dt, this.arena.height);
    if (view.camera) {
      this.cameraPosition.x += (view.camera.target.x - this.cameraPosition.x) * 2.5 * dt;
      this.cameraPosition.y += (view.camera.target.y - this.cameraPosition.y) * 2.5 * dt;
    }
    const height =
      displayed.primary === 'sniper' && playing
        ? (view.camera?.height ?? 7)
        : this.camera.position.y + ((view.camera?.height ?? 7) - this.camera.position.y) * 2.5 * dt;
    this.camera.position.set(this.cameraPosition.x, height, this.cameraPosition.y);
    this.camera.setTarget(new Vector3(this.cameraPosition.x, 0, this.cameraPosition.y));
    this.bodies.render(view, dt, rollDt);
    this.effects.render(dt);
    if (this.reducedEffects) this.clearBlood();
    else this.bloodEffects.render(dt);
    this.objects.render(view.objects ?? [], dt);
    this.scene.render();
  }

  minimap(view: ArenaView): void {
    drawMinimap(this.miniContext, this.arena, view, {
      ...this.cameraPosition,
      height: this.camera.position.y,
      fov: this.camera.fov,
    });
  }
}
