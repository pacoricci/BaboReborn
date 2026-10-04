import type { Vec2 } from '../../core/geometry';
import type { ShotGeometry } from '../../core/simulation';
import { MOVEMENT, SMG_MUZZLE } from '../../gameconfig/tuning';
import type { ArenaMap } from '../../maps/types';
import { YARD } from '../../maps/yard';

export interface PracticeConfig {
  readonly arena: ArenaMap;
  readonly start: Readonly<Vec2>;
  readonly startAngle: number;
  readonly targets: readonly Readonly<Vec2>[];
  readonly targetHealth: number;
  readonly targetRadius: number;
  readonly respawnSeconds: number;
  readonly flashSeconds: number;
  readonly motionAmplitude: number;
  readonly motionRate: number;
  readonly seed: number;
  readonly shotGeometry: ShotGeometry;
}

// Practice steps at the authority tick (core/timing.ts); long frames are clamped locally.
export const PRACTICE_MAX_FRAME_SECONDS = 0.1;

const TARGET_POSITIONS: readonly Readonly<Vec2>[] = [
  { x: 21, y: 10 },
  { x: 15, y: 11 },
  { x: 19, y: 13 },
  { x: 24, y: 5 },
  { x: 10, y: 12 },
  { x: 26, y: 16 },
  { x: 10, y: 24 },
  { x: 18, y: 25 },
  { x: 26, y: 25 },
  { x: 5, y: 18 },
  { x: 18, y: 32 },
  { x: 31, y: 20 },
];

export const DEFAULT_PRACTICE: PracticeConfig = {
  arena: YARD,
  start: { x: 18, y: 9 },
  startAngle: Math.PI / 2,
  targets: TARGET_POSITIONS,
  targetHealth: 100,
  targetRadius: MOVEMENT.radius,
  respawnSeconds: 3,
  flashSeconds: 0.12,
  motionAmplitude: 0.75,
  motionRate: 0.85,
  seed: 7291,
  // Extracted SMG attachment; the procedural map uses uniform 0.7-cell walls.
  shotGeometry: {
    muzzleOffset: SMG_MUZZLE.forward,
    muzzleSide: SMG_MUZZLE.right,
    muzzleHeight: SMG_MUZZLE.height,
    maxDistance: 128,
    wallHeight: 0.7,
  },
};
