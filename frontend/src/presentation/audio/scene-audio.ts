import type { ArenaView } from '../view';
import type { CombatAudio, AudioLoop } from './combat-audio';
import { AUDIO } from './limits';

type Position = { x: number; y: number; life: number | undefined; moving: boolean };
// Frame-local motion and persistent hazards. Finite gameplay transitions use accepted events.
export class SceneAudio {
  private previous = new Map<string, Position>();
  private scoped = false;
  constructor(private audio: Pick<CombatAudio, 'sample' | 'syncLoops' | 'setListener'>) {}

  reset(): void {
    this.previous.clear();
    this.scoped = false;
    this.audio.syncLoops([]);
  }
  update(view: ArenaView, elapsed: number, active = true): void {
    if (!active || elapsed <= 0 || elapsed > 0.25) {
      this.reset();
      return;
    }
    const listener =
      view.player.visible === false ? (view.camera?.target ?? view.player) : view.player;
    this.audio.setListener(listener);
    const loops: AudioLoop[] = [];
    const current = new Map<string, Position>();
    const move = (key: string, player: ArenaView['player']) => {
      if (player.visible === false) return;
      const before = this.previous.get(key);
      const speed =
        before && before.life === player.life
          ? Math.hypot(player.x - before.x, player.y - before.y) / elapsed
          : 0;
      const moving = speed > AUDIO.movementMinSpeed && speed < AUDIO.movementTeleportSpeed;
      current.set(key, { x: player.x, y: player.y, life: player.life, moving });
      if (moving)
        loops.push({
          key,
          kind: 'roll-loop',
          position: player,
          level: Math.min(1, speed / AUDIO.movementFullSpeed),
        });
      else if (before?.moving && before.life === player.life && speed < AUDIO.movementMinSpeed)
        this.audio.sample('roll-stop', player);
    };
    move('self', view.player);
    for (const actor of view.actors)
      move(`actor:${actor.id}`, { ...actor, angle: actor.angle ?? 0 });
    this.previous = current;
    for (const object of view.objects ?? []) {
      if (object.kind === 'flame' || object.kind === 'rocket')
        loops.push({
          key: `entity:${object.id}`,
          kind: object.kind === 'flame' ? 'fire-loop' : 'rocket-loop',
          position: object,
        });
    }
    const distance = (loop: AudioLoop) =>
      loop.position ? Math.hypot(loop.position.x - listener.x, loop.position.y - listener.y) : 0;
    loops.sort((a, b) => distance(a) - distance(b));
    // Reserve room for finite photon beams and a very quiet industrial bed.
    const selected = loops.slice(0, AUDIO.loops - 3);
    selected.push({ key: 'arena', kind: 'ambient-loop' });
    this.audio.syncLoops(selected);
    const scoped =
      view.player.visible !== false &&
      view.player.primary === 'sniper' &&
      (view.camera?.height ?? 0) > 10;
    if (scoped !== this.scoped) this.audio.sample(scoped ? 'scope-in' : 'scope-out');
    this.scoped = scoped;
  }
}
