// Portions adapted from BaboViolent 2, src/Game/Weapon.cpp.
// Copyright 2012 bitHeads inc.
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted for BaboReborn; see CREDITS.md and
// frontend/public/licenses/BaboViolent2.txt for provenance and the original notice.

// Primary rules and predicted action state. World entities remain authority-owned.
import {
  SMG,
  SHOTGUN,
  DUAL,
  CHAIN,
  SNIPER,
  BAZOOKA,
  PHOTON,
  FLAMETHROWER,
} from '../gameconfig/tuning';
import type { Primary } from './equipment';
import type { Input, Player } from './simulation';
const RULES = {
  smg: SMG,
  dual: DUAL,
  chain: CHAIN,
  shotgun: { ...SHOTGUN, minSpreadDegrees: 0, maxSpreadDegrees: 0 },
  sniper: { ...SNIPER, minSpreadDegrees: 0, maxSpreadDegrees: 0 },
  bazooka: { ...BAZOOKA, minSpreadDegrees: 0, maxSpreadDegrees: 0 },
  photon: { ...PHOTON, minSpreadDegrees: 0, maxSpreadDegrees: 0 },
  flamethrower: {
    ...FLAMETHROWER,
    minSpreadDegrees: FLAMETHROWER.spreadDegrees,
    maxSpreadDegrees: FLAMETHROWER.spreadDegrees,
  },
};
export function primaryRules(primary: Primary) {
  return RULES[primary];
}
export function weaponMuzzle(primary: Primary, barrel: number) {
  switch (primary) {
    case 'dual':
      return barrel === 0
        ? { right: DUAL.muzzleRight2, forward: DUAL.muzzleForward2, height: DUAL.muzzleHeight2 }
        : { right: DUAL.muzzleRight, forward: DUAL.muzzleForward, height: DUAL.muzzleHeight };
    case 'chain': {
      const index = (barrel + 1) % 4;
      return {
        right: CHAIN.muzzleRight - (index === 2 ? 0.1 : index === 0 ? 0 : 0.05),
        forward: CHAIN.muzzleForward,
        height: CHAIN.muzzleHeight + (index === 1 ? -0.05 : index === 3 ? 0.05 : 0),
      };
    }
    case 'sniper':
    case 'bazooka':
    case 'photon':
    case 'flamethrower': {
      const r = RULES[primary];
      return { right: r.muzzleRight, forward: r.muzzleForward, height: r.muzzleHeight };
    }
    default:
      return null;
  }
}
export function primaryReady(p: Player, input: Readonly<Input>, dt: number): boolean {
  const e = p.equipment;
  if (!input.fire) return false;
  if (e.primary === 'bazooka' && e.rocketActive) {
    if (e.rocketAge >= BAZOOKA.remoteDelaySeconds - 1e-9) e.primaryAction = 'detonate';
    return false;
  }
  if (p.cooldown > 1e-9 || e.meleeDelay > 1e-9 || e.throwDelay > 1e-9 || e.overheated) return false;
  if (e.primary === 'photon' && e.charge < PHOTON.chargeSeconds - 1e-9) {
    e.charge += dt;
    return false;
  }
  if (e.primary === 'flamethrower')
    e.fireTime =
      e.sinceShot < FLAMETHROWER.resetGapSeconds
        ? e.fireTime + FLAMETHROWER.fireIntervalSeconds
        : 0;
  return true;
}
export function finishPrimary(p: Player): void {
  const e = p.equipment,
    rule = primaryRules(e.primary);
  p.vx -= Math.cos(p.angle) * rule.recoil;
  p.vy -= Math.sin(p.angle) * rule.recoil;
  p.cooldown += rule.fireIntervalSeconds;
  e.charge = 0;
  e.sinceShot = 0;
  if (e.primary === 'dual') e.barrel = 1 - e.barrel;
  if (e.primary === 'chain') e.barrel = (e.barrel + 1) % 4;
  if (e.primary === 'chain') {
    e.heat -= CHAIN.heatPerShot;
    if (e.heat < 0) {
      e.heat = 0;
      e.overheated = true;
    }
  }
  if (e.primary === 'bazooka') {
    e.rocketActive = true;
    e.rocketAge = 0;
    e.primaryAction = 'rocket';
  }
}
export function updatePrimary(p: Player, input: Readonly<Input>, dt: number): void {
  const e = p.equipment;
  if (e.primary === 'chain') {
    e.heat = Math.min(1, e.heat + CHAIN.recovery * dt);
    if (e.heat > CHAIN.resumeAbove) e.overheated = false;
  }
  if (e.primary === 'sniper') {
    const height = Math.max(
      SNIPER.minHeight,
      Math.min(
        SNIPER.maxHeight,
        Math.hypot(input.aim.x - p.x, input.aim.y - p.y, 0.25) * SNIPER.aimScale,
      ),
    );
    e.scopeHeight += (height - e.scopeHeight) * Math.min(1, SNIPER.follow * dt);
  }
}
export function photonDamage(distance: number, damage = PHOTON.damage as number): number {
  return (
    damage *
    (PHOTON.verticalShift +
      PHOTON.coefficient *
        (Math.PI / 2 - Math.atan((distance - PHOTON.horizontalShift) * PHOTON.distanceMultiplier)))
  );
}
