import type { PlayerView, ActorView } from '../../presentation/view';
import type { PracticeWorld } from './simulation';

// The adapter owns mutable presentation buffers; the renderer sees read-only views.
// Reuse the buffers each frame. No entity/state serialization is needed for rendering.
export function createPracticeView(world: PracticeWorld) {
  const view: { player: PlayerView; actors: ActorView[] } = {
    player: { x: world.player.x, y: world.player.y, angle: world.player.angle },
    actors: world.targets.map((target) => ({
      id: target.id,
      x: target.x,
      y: target.y,
      visible: false,
      healthFraction: 0,
      hitFlash: false,
    })),
  };
  updatePracticeView(view, world, world.player);
  return view;
}

export function updatePracticeView(
  view: { player: PlayerView; actors: ActorView[] },
  world: PracticeWorld,
  displayed: Readonly<PlayerView>,
): void {
  view.player.x = displayed.x;
  view.player.y = displayed.y;
  view.player.angle = displayed.angle;
  view.actors.length = world.targets.length;
  for (let i = 0; i < world.targets.length; i++) {
    const target = world.targets[i]!; // The loop bounds use this same dense array.
    const actor = (view.actors[i] ??= {
      id: target.id,
      x: 0,
      y: 0,
      visible: false,
      healthFraction: 0,
      hitFlash: false,
    });
    actor.id = target.id;
    actor.x = target.x;
    actor.y = target.y;
    actor.visible = target.hp > 0;
    actor.healthFraction = target.hp / world.config.targetHealth;
    actor.hitFlash = target.flash > 0;
  }
}
