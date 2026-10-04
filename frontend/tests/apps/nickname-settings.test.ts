import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettings } from '../../src/player/player-settings';
import { defaultSettings } from '../../src/player/player-preferences';

void test('stored nickname colors are optional and invalid decoration does not discard settings', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored: unknown;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => JSON.stringify(stored) },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  stored = { nickname: 'AB', primary: 'sniper' };
  assert.equal(readSettings().nicknameColors, undefined);
  stored = { nickname: 'AB', nicknameColors: 'ff0000------' };
  assert.equal(readSettings().nicknameColors, 'ff0000------');
  stored = { nickname: 'AB', nicknameColors: 'red', primary: 'sniper' };
  assert.equal(readSettings().nickname, 'AB');
  assert.equal(readSettings().primary, 'sniper');
  assert.equal(readSettings().nicknameColors, undefined);
  stored = { nickname: '<bad>', nicknameColors: 'ff0000'.repeat(5), primary: 'sniper' };
  assert.equal(readSettings().nickname, defaultSettings.nickname);
  assert.equal(readSettings().nicknameColors, undefined);
  assert.equal(readSettings().primary, 'sniper');
});
