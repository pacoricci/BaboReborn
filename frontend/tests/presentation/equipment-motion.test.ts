import test from 'node:test';
import assert from 'node:assert/strict';
import { EquipmentMotion } from '../../src/presentation/actors/equipment-motion';

void test('rotor and shield envelopes are stable across render rates and stop after firing', () => {
  const run = (hz: number) => {
    const motion = new EquipmentMotion();
    for (let i = 0; i < hz; i++)
      motion.update('chain', 1, true, { shotAge: 0.03, charge: 0, reload: 0 }, true, 1 / hz);
    const active = { angle: motion.rotor, speed: motion.rotorSpeed, shield: motion.shield };
    for (let i = 0; i < hz; i++)
      motion.update('chain', 1, true, { shotAge: 2, charge: 0, reload: 0 }, false, 1 / hz);
    assert.ok(motion.rotorSpeed < 0.01);
    assert.equal(motion.shield, 0);
    return active;
  };
  const low = run(30),
    high = run(120);
  assert.ok(Math.abs(low.angle - high.angle) < 1e-9);
  assert.ok(Math.abs(low.speed - high.speed) < 1e-9);
  assert.ok(Math.abs(low.shield - high.shield) < 1e-9);
});
void test('charge holds the supplied state and reload does not start from ordinary cooldown', () => {
  const motion = new EquipmentMotion();
  const input = { shotAge: 2, charge: 0.7, reload: 0 };
  for (let i = 0; i < 120; i++) motion.update('photon', 1, true, input, false, 1 / 60);
  assert.equal(motion.charge, 0.7);
  assert.equal(motion.kick, 0);
  assert.equal(motion.reloadTilt, 0);
  motion.update('shotgun', 1, true, { shotAge: 1, charge: 0, reload: 0.5 }, false, 1 / 60);
  assert.equal(motion.charge, 0);
  assert.ok(motion.reloadTilt > 0);
  motion.update('shotgun', 1, true, { shotAge: 0.15, charge: 0, reload: 0 }, false, 1 / 60);
  assert.ok(motion.kick > 0);
  assert.equal(motion.reloadTilt, 0);
  assert.deepEqual(input, { shotAge: 2, charge: 0.7, reload: 0 });
});
void test('death, new life and weapon changes discard old animation impulses', () => {
  const motion = new EquipmentMotion();
  motion.update('smg', 1, true, undefined, false, 0);
  motion.shot();
  motion.update('smg', 1, true, undefined, true, 0.05);
  motion.update('smg', 1, true, undefined, true, 0.05);
  assert.ok(motion.kick > 0);
  assert.ok(motion.shield > 0);
  motion.update('smg', 2, true, undefined, false, 0.01);
  assert.equal(motion.kick, 0);
  assert.equal(motion.shield, 0);
  motion.shot();
  motion.update('sniper', 2, true, undefined, false, 0.01);
  assert.equal(motion.kick, 0);
  motion.update('chain', 2, false, { shotAge: 0, charge: 1, reload: 0.5 }, true, 0.1);
  assert.equal(motion.rotorSpeed, 0);
  assert.equal(motion.shield, 0);
});
