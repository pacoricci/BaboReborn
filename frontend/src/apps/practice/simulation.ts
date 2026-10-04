import { geometryWalls } from '../../maps/types';
import { createPlayer, stepPlayer } from '../../core/simulation';
import type {
  Damageable,
  Input,
  Player,
  RandomState,
  Shot,
  WorldGeometry,
} from '../../core/simulation';
import { createCollisionGrid } from '../../core/grid';
import type { Vec2 } from '../../core/geometry';
import { DEFAULT_PRACTICE } from './config';
import type { PracticeConfig } from './config';

interface PracticeTarget extends Damageable {
  readonly home: Readonly<Vec2>;
  respawn: number;
  flash: number;
}
export interface PracticeWorld {
  readonly config: PracticeConfig;
  readonly player: Player;
  readonly targets: PracticeTarget[];
  readonly random: RandomState;
  readonly geometry: WorldGeometry;
  time: number;
  shots: number;
  hits: number;
  eliminations: number;
  movingTargets: boolean;
}

export function createPractice(config: PracticeConfig = DEFAULT_PRACTICE): PracticeWorld {
  const walls = geometryWalls(config.arena);
  return {
    config,
    player: createPlayer(config.start, config.startAngle),
    geometry: {
      walls,
      grid: createCollisionGrid(
        { x: 0, y: 0, w: config.arena.width, h: config.arena.height },
        walls,
      ),
    },
    targets: config.targets.map((home, id) => ({
      ...home,
      home,
      id,
      radius: config.targetRadius,
      hp: config.targetHealth,
      respawn: 0,
      flash: 0,
    })),
    random: { seed: config.seed },
    time: 0,
    shots: 0,
    hits: 0,
    eliminations: 0,
    movingTargets: true,
  };
}

export function stepPractice(world: PracticeWorld, input: Input, dt: number): Shot | null {
  const config = world.config;
  world.time += dt;
  for (const target of world.targets) {
    target.flash = Math.max(0, target.flash - dt);
    if (target.hp === 0) {
      target.respawn = Math.max(0, target.respawn - dt);
      if (target.respawn === 0) {
        target.hp = config.targetHealth;
        target.x = target.home.x;
        target.y = target.home.y;
      }
    } else if (world.movingTargets) {
      target.x =
        target.home.x +
        Math.sin(world.time * config.motionRate + target.id) * config.motionAmplitude;
    }
  }
  const shot = stepPlayer(
    world.player,
    input,
    dt,
    world.geometry,
    world.targets,
    world.random,
    config.shotGeometry,
  );
  if (shot) {
    world.shots++;
    if (shot.hit) {
      world.hits++;
      const target = world.targets.find((body) => body.id === shot.targetId)!;
      target.flash = config.flashSeconds;
      if (shot.killed) {
        target.respawn = config.respawnSeconds;
        world.eliminations++;
      }
    }
  }
  return shot;
}
