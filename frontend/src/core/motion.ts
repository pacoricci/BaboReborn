import { mapImpact } from './ballistics';
import type { Vec3, Wall } from './geometry';
import { BAZOOKA, FLIGHT } from '../gameconfig/tuning';
import { TICK_HZ, TICK_SECONDS } from './timing';

export interface Flight {
  position: Vec3;
  velocity: Vec3;
}
export interface Motion extends Flight {
  motion: 'fixed' | 'bounce' | 'fall' | 'rocket' | 'attached';
  motionTick: number;
}
// Bound trajectory reconstruction to one second of authority steps.
export const MOTION_ANCHOR_TICKS = TICK_HZ;

// Keep operation order identical to core.StepFlight, including gravity BEFORE
// reflecting velocity, the surface clearance and the source rest predicate.
export function stepFlight(f: Flight, walls: readonly Wall[], height: number, bounce: boolean) {
  const v = f.velocity;
  if (
    bounce &&
    Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) <= FLIGHT.restSpeed &&
    f.position.z <= FLIGHT.restHeight
  ) {
    f.velocity = { x: 0, y: 0, z: 0 };
    return null;
  }
  const dt = TICK_SECONDS;
  const end = {
    x: f.position.x + v.x * dt,
    y: f.position.y + v.y * dt,
    z: f.position.z + v.z * dt,
  };
  v.z -= FLIGHT.gravity * dt;
  const { point, normal } = mapImpact(f.position, end, walls, height);
  f.position = point;
  if (normal && bounce) {
    point.x += normal.x * FLIGHT.surfaceClearance;
    point.y += normal.y * FLIGHT.surfaceClearance;
    point.z += normal.z * FLIGHT.surfaceClearance;
    const dot = v.x * normal.x + v.y * normal.y + v.z * normal.z;
    v.x = (v.x - 2 * dot * normal.x) * FLIGHT.bounceRetention;
    v.y = (v.y - 2 * dot * normal.y) * FLIGHT.bounceRetention;
    v.z = (v.z - 2 * dot * normal.z) * FLIGHT.bounceRetention;
  }
  return normal;
}
export function stepRocket(f: Flight): void {
  const speed = Math.hypot(f.velocity.x, f.velocity.y);
  if (speed > BAZOOKA.maxSpeed) {
    f.velocity.x *= BAZOOKA.maxSpeed / speed;
    f.velocity.y *= BAZOOKA.maxSpeed / speed;
  }
  f.position.x += f.velocity.x * TICK_SECONDS;
  f.position.y += f.velocity.y * TICK_SECONDS;
  f.velocity.x *= 1 + TICK_SECONDS * BAZOOKA.acceleration;
  f.velocity.y *= 1 + TICK_SECONDS * BAZOOKA.acceleration;
}
const copy = (f: Flight): Flight => ({ position: { ...f.position }, velocity: { ...f.velocity } });

// Weak ownership lets expired interpolation history release cached trajectories.
// Each anchor has at most 122 samples, independent of render rate or entity age.
export class MotionSampler {
  private cache = new WeakMap<Motion, { samples: Flight[]; walls: readonly Wall[] }>();
  constructor(
    private walls: readonly Wall[],
    private height: number,
  ) {}
  at(motion: Motion, tick: number): Flight {
    if (['fixed', 'attached'].includes(motion.motion)) return motion;
    const age = Math.max(0, Math.min(MOTION_ANCHOR_TICKS, tick - motion.motionTick));
    const n = Math.floor(age),
      alpha = age - n;
    let trajectory = this.cache.get(motion);
    if (!trajectory) {
      // Axis-aligned reflections never increase horizontal speed. Include every
      // possible surface-clearance push over the bounded replay, preserving wall
      // order and all contacts while avoiding a full-map scan at every tick.
      const seconds = MOTION_ANCHOR_TICKS * TICK_SECONDS;
      const clearance = MOTION_ANCHOR_TICKS * FLIGHT.surfaceClearance + 1e-9;
      const x = Math.abs(motion.velocity.x) * seconds + clearance;
      const y = Math.abs(motion.velocity.y) * seconds + clearance;
      trajectory = {
        samples: [copy(motion)],
        walls:
          motion.motion === 'rocket'
            ? []
            : this.walls.filter(
                (w) =>
                  w.x <= motion.position.x + x &&
                  w.x + w.w >= motion.position.x - x &&
                  w.y <= motion.position.y + y &&
                  w.y + w.h >= motion.position.y - y,
              ),
      };
      this.cache.set(motion, trajectory);
    }
    const { samples, walls } = trajectory;
    while (samples.length <= n + (alpha > 0 ? 1 : 0)) {
      const f = copy(samples.at(-1)!);
      if (motion.motion === 'rocket') stepRocket(f);
      else stepFlight(f, walls, this.height, motion.motion === 'bounce');
      samples.push(f);
    }
    const a = samples[n]!,
      b = samples[n + 1] ?? a;
    return {
      velocity: a.velocity,
      position: {
        x: a.position.x + (b.position.x - a.position.x) * alpha,
        y: a.position.y + (b.position.y - a.position.y) * alpha,
        z: a.position.z + (b.position.z - a.position.z) * alpha,
      },
    };
  }
}
