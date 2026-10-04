// Portions adapted from BaboViolent 2, src/Game/PlayerUpdate.cpp and Weapon.cpp.
// Copyright 2012 bitHeads inc.
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted for BaboReborn; see CREDITS.md and
// frontend/public/licenses/BaboViolent2.txt for provenance and the original notice.

import {
  weaponMuzzle,
  primaryRules,
  primaryReady,
  finishPrimary,
  updatePrimary,
  photonDamage,
} from './weapons';
import { clamp } from './geometry';
import type { Vec2, Vec3, Wall, MovingBody } from './geometry';
import { mapImpact, sphereImpact } from './ballistics';
import { resolveGrid } from './grid';
import type { GridObserver, CollisionGrid } from './grid';
import { MOVEMENT, SMG, SHOTGUN, FLIGHT, CHAIN, SNIPER, FLAMETHROWER } from '../gameconfig/tuning';
import { act, createEquipment, updateEquipment } from './equipment';
import type { Equipment } from './equipment';

export interface Input {
  x: number;
  y: number;
  aim: Readonly<Vec2>;
  fire: boolean;
  secondary?: boolean;
  grenade?: boolean;
  molotov?: boolean;
  pickup?: number;
}
export interface Player extends MovingBody {
  angle: number; // [radians]
  cooldown: number; // [s]
  spread: number; // [degrees]
  equipment: Equipment;
}
// Callers supply only bodies that can be hit, excluding the shooter.
// Health changes here; respawn, scoring and visual feedback belong to the consumer.
export interface Damageable extends Vec2 {
  readonly id: number;
  readonly radius: number;
  hp: number;
}
export interface Shot {
  surface?: boolean;
  kind?: string;
  from: Vec3;
  to: Vec3;
  hit: boolean;
  killed: boolean;
  targetId: number | null;
  pellets?: Shot[];
}
export interface RandomState {
  seed: number;
}
export interface WorldGeometry {
  readonly walls: readonly Wall[];
  readonly grid: CollisionGrid;
}
// Geometry approximations are explicit inputs, not confirmed gameplay constants.
export interface ShotGeometry {
  readonly muzzleOffset: number;
  readonly muzzleSide: number;
  readonly muzzleHeight: number;
  readonly maxDistance: number;
  readonly wallHeight: number;
}

export function createPlayer(position: Readonly<Vec2>, angle: number): Player {
  return {
    equipment: createEquipment(),
    ...position,
    vx: 0,
    vy: 0,
    angle,
    cooldown: SMG.equipDelaySeconds,
    spread: SMG.minSpreadDegrees,
  };
}

function nextRandom(random: RandomState): number {
  random.seed = (Math.imul(random.seed, 1664525) + 1013904223) >>> 0;
  return random.seed / 4294967296;
}

function fire(
  p: Player,
  walls: readonly Wall[],
  bodies: readonly Damageable[],
  random: RandomState,
  geometry: ShotGeometry,
  pellet = -1,
): Shot {
  const rule = primaryRules(p.equipment.primary);
  const shotgun = p.equipment.primary === 'shotgun' && pellet >= 0;
  const beam = p.equipment.primary === 'photon' || p.equipment.primary === 'flamethrower';
  const angle =
    p.angle +
    (!shotgun
      ? 0
      : ((pellet - (SHOTGUN.pellets - 1) / 2) * SHOTGUN.pelletAngleDegrees * Math.PI) / 180);
  const forward = { x: Math.cos(angle), y: Math.sin(angle) };
  if (pellet < 0) p.spread = Math.min(rule.maxSpreadDegrees, p.spread + SMG.spreadPerShotDegrees);
  // Pro uses angular spread with a random rotation around the firing axis,
  // then halves the vertical deviation. Use explicit seeded randomness for reproducible simulation.
  let spread = shotgun ? SHOTGUN.spreadDegrees : rule.maxSpreadDegrees === 0 ? 0 : p.spread;
  if (p.equipment.primary === 'chain' && Math.hypot(p.vx, p.vy) < CHAIN.precisionSpeed)
    spread /= CHAIN.precisionDivisor;
  const deviation = ((nextRandom(random) * 2 - 1) * spread * Math.PI) / 180;
  const roll = nextRandom(random) * Math.PI * 2;
  const lateral = Math.sin(deviation) * Math.cos(roll);
  const direction = {
    x: forward.x * Math.cos(deviation) - forward.y * lateral,
    y: forward.y * Math.cos(deviation) + forward.x * lateral,
  };
  const dz = Math.sin(deviation) * Math.sin(roll) * SMG.verticalSpreadScale;
  const length = Math.hypot(direction.x, direction.y, dz);
  const sinTheta =
    Math.hypot(dz, direction.x * Math.sin(p.angle) - direction.y * Math.cos(p.angle)) / length;
  const range = shotgun
    ? SHOTGUN.rangeScale / Math.max(sinTheta, 1e-12) / length
    : p.equipment.primary === 'flamethrower'
      ? Math.max(
          FLAMETHROWER.minRange,
          (1 - p.equipment.fireTime / FLAMETHROWER.expirationSeconds) * FLAMETHROWER.maxRange,
        )
      : geometry.maxDistance;
  const muzzle = {
    x: p.x + Math.cos(p.angle) * geometry.muzzleOffset + Math.sin(p.angle) * geometry.muzzleSide,
    y: p.y + Math.sin(p.angle) * geometry.muzzleOffset - Math.cos(p.angle) * geometry.muzzleSide,
    z: geometry.muzzleHeight,
  };
  // The endpoint is computed before repairing a muzzle that overlaps cover.
  const endpoint = {
    x: muzzle.x + direction.x * range,
    y: muzzle.y + direction.y * range,
    z: muzzle.z + dz * range,
  };
  const clearance = mapImpact(
    { x: p.x, y: p.y, z: MOVEMENT.radius },
    muzzle,
    walls,
    geometry.wallHeight,
  );
  const from = clearance.point;
  if (clearance.normal) {
    from.x += clearance.normal.x * FLIGHT.surfaceClearance;
    from.y += clearance.normal.y * FLIGHT.surfaceClearance;
    from.z += clearance.normal.z * FLIGHT.surfaceClearance;
  }
  const surface = mapImpact(from, endpoint, walls, geometry.wallHeight);
  let to = surface.point;
  let victim: Damageable | undefined;
  for (const target of p.equipment.primary === 'bazooka' ? [] : bodies) {
    if (target.hp <= 0) continue;
    const point = sphereImpact(
      from,
      to,
      { x: target.x, y: target.y, z: target.radius },
      p.equipment.primary === 'flamethrower' ? FLAMETHROWER.hitRadius : target.radius,
    );
    if (point) {
      if (!beam) to = point;
      victim = target;
      if (beam) {
        const distance = Math.hypot(target.x - from.x, target.y - from.y, target.radius - from.z);
        const damage =
          p.equipment.primary === 'photon'
            ? photonDamage(distance)
            : FLAMETHROWER.damage * Math.max(0, 1 - distance / FLAMETHROWER.maxRange);
        target.hp = Math.max(0, target.hp - damage);
      }
    }
  }
  if (victim && !beam) victim.hp = Math.max(0, victim.hp - rule.damage);
  return {
    kind: p.equipment.primary,
    ...(surface.normal && (!victim || beam) ? { surface: true } : {}),
    from,
    to,
    hit: !!victim,
    killed: victim?.hp === 0,
    targetId: victim?.id ?? null,
  };
}

// The caller owns the clock and chooses a positive fixed dt. State is updated in
// place; geometry and the body list are borrowed, without per-tick entity copies.
export function stepPlayer(
  p: Player,
  input: Readonly<Input>,
  dt: number,
  world: WorldGeometry,
  bodies: readonly Damageable[],
  random: RandomState,
  geometry: ShotGeometry,
  observeGrid?: GridObserver,
): Shot | null {
  p.cooldown = Math.max(0, p.cooldown - dt);
  p.spread = Math.max(
    primaryRules(p.equipment.primary).minSpreadDegrees,
    p.spread - SMG.spreadRecoveryDegreesPerSecond * dt,
  );
  updateEquipment(p, dt);
  if (p.equipment.primary === 'shotgun')
    geometry = {
      ...geometry,
      muzzleOffset: SHOTGUN.muzzleForward,
      muzzleSide: SHOTGUN.muzzleRight,
    };
  const muzzle = weaponMuzzle(p.equipment.primary, p.equipment.barrel);
  if (muzzle)
    geometry = {
      ...geometry,
      muzzleSide: muzzle.right,
      muzzleOffset: muzzle.forward,
      muzzleHeight: muzzle.height,
    };
  // Preserve the original order: integrate old velocity, drag, controls, recoil, cap.
  const previousX = p.x,
    previousY = p.y;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  const speed = Math.hypot(p.vx, p.vy);
  const remaining = Math.max(0, speed - MOVEMENT.friction * dt);
  if (speed > 0) {
    p.vx *= remaining / speed;
    p.vy *= remaining / speed;
  }
  p.vx += clamp(input.x, -1, 1) * MOVEMENT.acceleration * dt;
  p.vy += clamp(input.y, -1, 1) * MOVEMENT.acceleration * dt;
  // Original controlIt fires with the existing angle before update reorients it.
  let shot: Shot | null = null;
  if (primaryReady(p, input, dt)) {
    if (p.equipment.primary === 'shotgun') {
      const pellets = Array.from({ length: SHOTGUN.pellets }, (_, i) =>
        fire(p, world.walls, bodies, random, geometry, i),
      );
      shot = { ...pellets[0]!, pellets };
      p.vx -= Math.cos(p.angle) * SHOTGUN.recoil;
      p.vy -= Math.sin(p.angle) * SHOTGUN.recoil;
      p.equipment.shells++;
      p.cooldown =
        p.equipment.shells === SHOTGUN.shells ? SHOTGUN.reloadSeconds : SHOTGUN.fireIntervalSeconds;
    } else {
      if (p.equipment.primary === 'sniper') {
        const count =
          p.equipment.scopeHeight >= SNIPER.scopeThreshold ? SNIPER.scopedRays : SNIPER.normalRays;
        const pellets = Array.from({ length: count }, (_, i) =>
          fire(p, world.walls, bodies, random, geometry, i),
        );
        shot = { ...pellets[0]!, pellets };
      } else shot = fire(p, world.walls, bodies, random, geometry);
      finishPrimary(p);
    }
  }
  updatePrimary(p, input, dt);
  act(p, input);
  const nextSpeed = Math.hypot(p.vx, p.vy);
  if (nextSpeed > MOVEMENT.maxSpeed) {
    p.vx *= MOVEMENT.maxSpeed / nextSpeed;
    p.vy *= MOVEMENT.maxSpeed / nextSpeed;
  }
  const close =
    Math.hypot(input.aim.x - p.x, input.aim.y - p.y, MOVEMENT.radius) <= SMG.closeAimDistance;
  const ox = close
    ? p.x
    : p.x + Math.cos(p.angle) * geometry.muzzleOffset + Math.sin(p.angle) * geometry.muzzleSide;
  const oy = close
    ? p.y
    : p.y + Math.sin(p.angle) * geometry.muzzleOffset - Math.cos(p.angle) * geometry.muzzleSide;
  if (Math.hypot(input.aim.x - ox, input.aim.y - oy) > 1e-8)
    p.angle = Math.atan2(input.aim.y - oy, input.aim.x - ox);
  resolveGrid(
    p,
    previousX,
    previousY,
    world.grid,
    MOVEMENT.radius,
    MOVEMENT.bounce,
    MOVEMENT.clearance,
    observeGrid,
  );
  return shot;
}
