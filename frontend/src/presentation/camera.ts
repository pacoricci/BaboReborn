import { clamp } from '../core/geometry';
import type { Vec2 } from '../core/geometry';

import { CAMERA } from '../gameconfig/tuning';
export { CAMERA } from '../gameconfig/tuning';

// Shared target math also keeps the final alive target when the player dies.
export function cameraTarget(
  player: Readonly<Vec2>,
  aim: Readonly<Vec2>,
  size: number,
  height = size,
): Vec2 {
  const weight = CAMERA.playerWeight + CAMERA.aimWeight;
  return {
    x: clamp(
      (player.x * CAMERA.playerWeight + aim.x * CAMERA.aimWeight) / weight,
      CAMERA.marginX,
      size - CAMERA.marginX,
    ),
    y: clamp(
      (player.y * CAMERA.playerWeight + aim.y * CAMERA.aimWeight) / weight,
      CAMERA.marginY,
      height - CAMERA.marginY,
    ),
  };
}

export function followCamera(
  position: Vec2,
  player: Readonly<Vec2>,
  aim: Readonly<Vec2>,
  size: number,
  dt: number,
  height = size,
): void {
  const weight = CAMERA.playerWeight + CAMERA.aimWeight;
  const x = clamp(
    (player.x * CAMERA.playerWeight + aim.x * CAMERA.aimWeight) / weight,
    CAMERA.marginX,
    size - CAMERA.marginX,
  );
  const y = clamp(
    (player.y * CAMERA.playerWeight + aim.y * CAMERA.aimWeight) / weight,
    CAMERA.marginY,
    height - CAMERA.marginY,
  );
  // Map::update uses a linear coefficient at each update, not an exponential.
  position.x += (x - position.x) * CAMERA.follow * dt;
  position.y += (y - position.y) * CAMERA.follow * dt;
}
