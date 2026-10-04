import assert from 'node:assert/strict';
import test from 'node:test';
import { primaryReloadProgress } from '../../src/apps/match/primary-reload';
import { createPlayer } from '../../src/core/simulation';
import { finishPrimary } from '../../src/core/weapons';
import { SHOTGUN } from '../../src/gameconfig/tuning';

void test('shotgun shows magazine reload only and clears when ready or inactive', () => {
  const player = createPlayer({ x: 0, y: 0 }, 0);
  player.cooldown = 0;
  player.equipment.primary = 'shotgun';
  player.equipment.shells = 1;
  player.cooldown = SHOTGUN.fireIntervalSeconds;
  assert.equal(primaryReloadProgress(player, true), null);
  player.equipment.shells = SHOTGUN.shells;
  player.cooldown = SHOTGUN.reloadSeconds;
  assert.equal(primaryReloadProgress(player, true), 0);
  player.cooldown /= 2;
  assert.equal(primaryReloadProgress(player, true), 0.5);
  assert.equal(primaryReloadProgress(player, false), null);
  player.cooldown = 0;
  assert.equal(primaryReloadProgress(player, true), null);
});

void test('slow primaries use actual post-shot cooldown and discard progress on weapon swap', () => {
  for (const primary of ['sniper', 'bazooka', 'photon'] as const) {
    const player = createPlayer({ x: 0, y: 0 }, 0);
    player.cooldown = 0;
    player.equipment.primary = primary;
    finishPrimary(player);
    assert.equal(primaryReloadProgress(player, true), 0);
    player.cooldown /= 2;
    assert.equal(primaryReloadProgress(player, true), 0.5);
    player.equipment.primary = 'smg';
    assert.equal(primaryReloadProgress(player, true), null);
  }
});

void test('automatic fire, secondary recovery and photon charge do not display a reload', () => {
  assert.equal(primaryReloadProgress(null, true), null);
  for (const primary of ['smg', 'dual', 'chain', 'flamethrower'] as const) {
    const player = createPlayer({ x: 0, y: 0 }, 0);
    player.cooldown = 0;
    player.equipment.primary = primary;
    finishPrimary(player);
    assert.equal(primaryReloadProgress(player, true), null);
  }
  const player = createPlayer({ x: 0, y: 0 }, 0);
  player.cooldown = 0;
  player.equipment.primary = 'photon';
  player.equipment.charge = 0.25;
  player.equipment.meleeDelay = 1;
  assert.equal(primaryReloadProgress(player, true), null);
});
