import { skins as SKIN_TEMPLATES } from '../support/content';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APPEARANCE, isAppearance } from '../../src/player/appearance';
import { parseServerMessage } from '../../src/network/protocol';
import { snap } from '../support/online';
import { Rolling } from '../../src/presentation/actors/rolling';

void test('appearance accepts only catalog templates and exactly three RGB colors', () => {
  assert.ok(isAppearance(DEFAULT_APPEARANCE));
  assert.equal(SKIN_TEMPLATES.length, 15);
  for (const { id } of SKIN_TEMPLATES)
    assert.ok(isAppearance({ template: id, colors: ['#000000', '#ffffff', '#ABC123'] }));
  for (const value of [
    null,
    {},
    { ...DEFAULT_APPEARANCE, template: '../skin' },
    ...[
      [],
      ['#123456'],
      ['#123456', '#123456', '#123456', '#123456'],
      ['red', '#fff', '#123456'],
    ].map((colors) => ({ ...DEFAULT_APPEARANCE, colors })),
  ])
    assert.equal(isAppearance(value), false);
});
void test('every skin survives appearance snapshot decoding', () => {
  for (const { id } of SKIN_TEMPLATES) {
    const message = snap(1);
    const appearance = { ...DEFAULT_APPEARANCE, template: id };
    const value = {
      ...message,
      players: message.players.map((player) => ({
        ...player,
        appearance,
      })),
    };
    assert.deepEqual(parseServerMessage(JSON.stringify(value)), value);
  }
});
const quaternion = (q: Rolling) => [q.x, q.y, q.z, q.w];
void test('rolling follows displacement at original rate and accumulates in world space', () => {
  const a = new Rolling(),
    b = new Rolling();
  a.update(0, 0, 1, true, 0);
  b.update(0, 0, 1, true, 0);
  a.update(0.5, 0, 1, true, 0.1);
  assert.ok(Math.abs(a.z + Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(a.w - Math.SQRT1_2) < 1e-12);
  for (let i = 1; i <= 10; i++) b.update(i / 20, 0, 1, true, 0.01);
  quaternion(a).forEach((v, i) => assert.ok(Math.abs(v - quaternion(b)[i]!) < 1e-12));
  const stationary = quaternion(a);
  a.update(0.5, 0, 1, true, 0.1);
  assert.deepEqual(quaternion(a), stationary);
  a.update(0, 0, 1, true, 0.1);
  assert.ok(Math.abs(a.w - 1) < 1e-12);
  for (let i = 0; i < 10000; i++) a.update(Math.sin(i / 100), Math.cos(i / 100), 1, true, 0.01);
  assert.ok(Math.abs(Math.hypot(...quaternion(a)) - 1) < 1e-12);
});
void test('rolling reanchors large corrections and suspension, resets on new life and invisibility', () => {
  const q = new Rolling();
  q.update(0, 0, 1, true, 0);
  q.update(0.1, 0, 1, true, 0.1);
  const before = quaternion(q);
  q.update(12, 12, 1, true, 0.1);
  assert.deepEqual(quaternion(q), before);
  q.update(12.1, 12, 1, true, 1);
  assert.deepEqual(quaternion(q), before);
  q.update(4, 4, 2, true, 0.01);
  assert.deepEqual(quaternion(q), [0, 0, 0, 1]);
  q.update(4.1, 4, 2, true, 0.1);
  q.update(4.2, 4, 2, false, 0.1);
  assert.deepEqual(quaternion(q), [0, 0, 0, 1]);
  q.update(10, 10, 2, true, 0.1);
  assert.deepEqual(quaternion(q), [0, 0, 0, 1]);
});
