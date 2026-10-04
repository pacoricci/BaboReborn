import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { ArenaRenderer } from '../scene/renderer';
import type { ArenaView, PlayerView } from '../view';
import type { ProfileSelection } from './skin-preview';

const INITIAL_YAW = Math.atan2(1.3, 1.72);
const INITIAL_PITCH = Math.atan2(1.08, Math.hypot(1.3, 1.72));
const DISTANCE = Math.hypot(1.3, 1.08, 1.72);

// Cosmetic inspection scene: reuse the game's actor, primary mounts and skin.
// The synthetic travel only drives Rolling; there is no gameplay simulation here.
export class ProfileStage {
  private readonly renderer: ArenaRenderer;
  private readonly player: PlayerView;
  private readonly view: ArenaView;
  private readonly target = new Vector3();
  private readonly aim = { x: 9, y: 8 };
  private yaw = INITIAL_YAW;
  private pitch = INITIAL_PITCH;

  constructor(canvas: HTMLCanvasElement, selection: ProfileSelection) {
    this.player = {
      x: 8,
      y: 8,
      angle: 0,
      appearance: selection.appearance,
      primary: selection.primary,
    };
    this.view = { player: this.player, actors: [] };
    this.renderer = new ArenaRenderer(
      canvas,
      document.createElement('canvas'),
      {
        schema: 1,
        theme: 'classic',
        id: 'profile',
        name: 'Profile preview',
        author: '',
        width: 16,
        height: 16,
        walls: [],
        spawns: [],
      },
      this.view,
      { paths: [] },
      undefined,
      undefined,
      false,
    );
    const { scene, camera } = this.renderer;
    scene.clearColor = new Color4(0, 0, 0, 0);
    scene.getMeshByName('floor')?.setEnabled(false);
    scene.shadowsEnabled = false;
    camera.unfreezeProjectionMatrix();
    camera.minZ = 0.05;
    camera.fov = 0.65;
    camera.upVector.set(0, 1, 0);
    // Track the cosmetic travel so the body rolls in place and equipment stays readable.
    scene.onBeforeRenderObservable.add(() => {
      const x = this.player.x;
      this.target.set(x, 0.22, this.player.y + 0.08);
      const horizontal = DISTANCE * Math.cos(this.pitch);
      camera.position.set(
        this.target.x + horizontal * Math.sin(this.yaw),
        this.target.y + DISTANCE * Math.sin(this.pitch),
        this.target.z + horizontal * Math.cos(this.yaw),
      );
      camera.setTarget(this.target);
    });
  }

  resize(): void {
    this.renderer.engine.resize();
  }

  orbit(horizontal: number, vertical: number): void {
    this.yaw = (this.yaw - horizontal) % (Math.PI * 2);
    // Keep the camera above the Babo and clear of the vertical orbit singularity.
    this.pitch = Math.max(0.1, Math.min(1.45, this.pitch + vertical));
  }

  resetView(): void {
    this.yaw = INITIAL_YAW;
    this.pitch = INITIAL_PITCH;
  }

  async ready(): Promise<boolean> {
    await this.renderer.kit.models.ready;
    return !Object.values(this.renderer.kit.status).includes('failed');
  }

  render(selection: ProfileSelection, dt: number, paused: boolean): void {
    const p = this.player;
    if (!paused) p.x += dt * 0.65;
    p.appearance = selection.appearance;
    p.primary = selection.primary;
    this.renderer.render(this.view, this.aim, dt, false);
  }

  dispose(): void {
    this.renderer.scene.dispose();
    this.renderer.engine.dispose();
  }
}
