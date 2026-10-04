import { SceneAudio } from '../../presentation/audio/scene-audio';
import type { ArenaView } from '../../presentation/view';
import { CombatAudio } from '../../presentation/audio/combat-audio';

// The range uses the same samples and voice lifecycle as multiplayer.
export class RangeAudio {
  private readonly audio = new CombatAudio();
  private readonly scene = new SceneAudio(this.audio);

  constructor() {
    this.audio.enabled = false;
  }

  get enabled(): boolean {
    return this.audio.enabled;
  }

  set enabled(value: boolean) {
    this.audio.enabled = value;
  }

  async toggle(): Promise<boolean> {
    this.audio.enabled = !this.audio.enabled;
    if (this.audio.enabled) await this.unlock();
    return this.audio.enabled;
  }

  async unlock(): Promise<void> {
    await this.audio.unlock();
  }

  update(view: ArenaView, elapsed: number, active: boolean): void {
    this.scene.update(view, elapsed, active && this.enabled);
  }

  stop(): void {
    this.scene.reset();
    this.audio.stop();
  }

  shot(hit: boolean): void {
    this.audio.shot('smg');
    if (hit) this.audio.cue('hit');
  }
}
