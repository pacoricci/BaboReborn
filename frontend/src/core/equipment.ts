import { GRENADE, MOLOTOV, SHIELD, KNIVES, MINIBOT, SHOTGUN, THROWING } from '../gameconfig/tuning';
// Source-derived local action state. Damage and world entities belong to the authority.
import type { Input, Player } from './simulation';
export const PRIMARIES = [
  'smg',
  'shotgun',
  'dual',
  'chain',
  'sniper',
  'bazooka',
  'photon',
  'flamethrower',
] as const;
export const SECONDARIES = ['knives', 'shield', 'minibot'] as const;
export type Primary = (typeof PRIMARIES)[number];
export type Secondary = (typeof SECONDARIES)[number];
export const isPrimary = (value: unknown): value is Primary =>
  typeof value === 'string' && (PRIMARIES as readonly string[]).includes(value);
export const isSecondary = (value: unknown): value is Secondary =>
  typeof value === 'string' && (SECONDARIES as readonly string[]).includes(value);
export const EQUIPMENT_NAMES: Record<Primary | Secondary, string> = {
  smg: 'SMG',
  shotgun: 'Shotgun',
  dual: 'Dual Machine Gun',
  chain: 'Chain Gun',
  sniper: 'Sniper Rifle',
  bazooka: 'Bazooka',
  photon: 'Photon Rifle',
  flamethrower: 'Flamethrower',
  knives: 'Popup Knives',
  shield: 'Instant Shield',
  minibot: 'Mini Bot',
};
export interface Equipment {
  heat: number; // [ratio]
  overheated: boolean;
  charge: number; // [s]
  fireTime: number; // [s]
  sinceShot: number; // [s]
  scopeHeight: number; // [cells]
  rocketActive: boolean;
  rocketAge: number; // [s]
  primaryAction: '' | 'rocket' | 'detonate';
  barrel: number;
  primary: Primary;
  secondary: Secondary;
  grenades: number;
  molotovs: number;
  shells: number;
  meleeDelay: number; // [s]
  throwDelay: number; // [s]
  protection: number; // [s]
  secondaryActivated: boolean;
  action: '' | Secondary | 'grenade' | 'molotov';
}
export function createEquipment(
  primary: Primary = 'smg',
  secondary: Secondary = 'knives',
): Equipment {
  return {
    heat: 1,
    overheated: false,
    charge: 0,
    fireTime: 0,
    sinceShot: 1,
    scopeHeight: 7,
    rocketActive: false,
    rocketAge: 0,
    primaryAction: '',
    barrel: 0,
    primary,
    secondary,
    grenades: GRENADE.spawnCount,
    molotovs: MOLOTOV.spawnCount,
    shells: 0,
    meleeDelay: 0,
    throwDelay: 0,
    protection: 0,
    secondaryActivated: false,
    action: '',
  };
}
export function updateEquipment(p: Player, dt: number): void {
  const e = p.equipment;
  e.action = '';
  e.primaryAction = '';
  e.sinceShot += dt;
  if (e.rocketActive) e.rocketAge += dt;
  e.secondaryActivated = false;
  e.meleeDelay = Math.max(0, e.meleeDelay - dt);
  e.throwDelay = Math.max(0, e.throwDelay - dt);
  e.protection = Math.max(0, e.protection - dt);
  if (e.shells === SHOTGUN.shells && p.cooldown <= 1e-9) e.shells = 0;
}
function canFire(p: Player): boolean {
  return p.equipment.meleeDelay <= 1e-9 && p.equipment.throwDelay <= 1e-9;
}
export function act(p: Player, input: Readonly<Input>): void {
  const e = p.equipment;
  if (input.secondary && canFire(p)) {
    e.action = e.secondary;
    e.secondaryActivated = true;
    e.meleeDelay =
      e.secondary === 'shield'
        ? SHIELD.cooldownSeconds
        : e.secondary === 'minibot'
          ? MINIBOT.cooldownSeconds
          : KNIVES.cooldownSeconds;
    if (e.secondary === 'shield') e.protection = SHIELD.protectionSeconds;
  }
  // Original Molotov input does not check meleeDelay; grenade input does.
  if (e.throwDelay > 1e-9 || p.cooldown > 1e-9) return;
  if (input.grenade && e.grenades > 0 && e.meleeDelay <= 1e-9) {
    e.grenades--;
    e.action = 'grenade';
  } else if (input.molotov && e.molotovs > 0) {
    e.molotovs--;
    e.action = 'molotov';
  } else return;
  e.throwDelay = THROWING.cooldownSeconds;
  p.vx += Math.cos(p.angle) * THROWING.impulse;
  p.vy += Math.sin(p.angle) * THROWING.impulse;
}
