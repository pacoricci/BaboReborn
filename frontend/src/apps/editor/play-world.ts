import { geometryWalls } from '../../maps/types';
import type { ArenaMap } from '../../maps/types';
import { createCollisionGrid } from '../../core/grid';
import { createPlayer, stepPlayer } from '../../core/simulation';
import type { Input } from '../../core/simulation';
import { TICK_SECONDS } from '../../core/timing';
import { SMG_MUZZLE } from '../../gameconfig/tuning';

// Local walk/shoot inspection uses the game core, with no practice targets or match rules.
export function createMapTrial(arena: ArenaMap, spawn = 0) {
  const start = arena.spawns[spawn];
  if (!start) throw new Error('Choose an existing spawn.');
  const player = createPlayer(start, Math.PI / 2);
  const walls = geometryWalls(arena);
  const geometry = {
    walls,
    grid: createCollisionGrid({ x: 0, y: 0, w: arena.width, h: arena.height }, walls),
  };
  const random = { seed: 7291 };
  return {
    player,
    step(input: Input) {
      return stepPlayer(player, input, TICK_SECONDS, geometry, [], random, {
        muzzleOffset: SMG_MUZZLE.forward,
        muzzleSide: SMG_MUZZLE.right,
        muzzleHeight: SMG_MUZZLE.height,
        maxDistance: 128,
        wallHeight: 0.7,
      });
    },
  };
}
