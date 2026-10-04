import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFavorites, toggleFavorite } from '../../src/apps/play/favorites';

const roomID = 'c'.repeat(32);
const first = `${'a'.repeat(32)}.${roomID}`;
const second = `${'b'.repeat(32)}.${roomID}`;

void test('favorite references round-trip and distinguish rooms across servers', () => {
  const original = [first];
  const both = toggleFavorite(original, second);
  assert.deepEqual(original, [first]);
  assert.deepEqual(parseFavorites(JSON.stringify(both)), [first, second]);
  assert.deepEqual(toggleFavorite(both, first), [second]);
  assert.deepEqual(parseFavorites(JSON.stringify([first, first])), [first]);
  assert.deepEqual(parseFavorites(null), []);
});

void test('favorite storage rejects malformed data and objects in place of room references', () => {
  for (const raw of [
    '{',
    '{}',
    '[null]',
    '[42]',
    '["invalid"]',
    JSON.stringify([{ ref: first }]),
  ]) {
    assert.throws(() => parseFavorites(raw));
  }
  assert.throws(() => toggleFavorite([], 'invalid'));
});
