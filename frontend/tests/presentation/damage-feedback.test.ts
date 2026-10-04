import test from 'node:test';
import assert from 'node:assert/strict';
import { DamageFeedback } from '../../src/presentation/effects/damage-feedback';

void test('screen-hit feedback scales with damage and fades at the original rate', () => {
  const feedback = new DamageFeedback();
  feedback.hit(10, 1000);
  assert.ok(Math.abs(feedback.opacity(1000) - 0.3) < 1e-12);
  assert.ok(Math.abs(feedback.opacity(1200) - 0.15) < 1e-12);
  assert.equal(feedback.opacity(1400), 0);
  feedback.hit(50, 2000);
  assert.equal(feedback.opacity(2000), 1);
  assert.ok(Math.abs(feedback.opacity(3600) - 0.3) < 1e-12);
  assert.equal(feedback.opacity(4000), 0);
});

void test('successive hits accumulate after decay, saturate and clear on life changes', () => {
  const feedback = new DamageFeedback();
  feedback.hit(10, 0);
  feedback.hit(10, 200);
  assert.ok(Math.abs(feedback.opacity(200) - 0.45) < 1e-12);
  feedback.hit(100, 200);
  feedback.hit(100, 200);
  assert.equal(feedback.opacity(200), 1);
  assert.equal(feedback.opacity(4200), 0);
  feedback.hit(50, 4500);
  feedback.reset();
  assert.equal(feedback.opacity(4500), 0);
});
