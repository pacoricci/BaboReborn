import test from 'node:test';
import assert from 'node:assert/strict';
import { editNicknameColors, nicknameRuns, validNicknameColors } from '../../src/player/nickname';
import { parseServerMessage } from '../../src/network/protocol';
import { eventHeader, snap, welcome } from '../support/online';

void test('server bot icons are accepted in snapshots and activity participants', () => {
  for (const nickname of ['▣ Bot 01', '▣ Bot 123', 'Player 1']) {
    const frame = snap(1);
    frame.players[0]!.nickname = nickname;
    assert.deepEqual(parseServerMessage(JSON.stringify(frame)), frame);
    const actor = { id: 1, team: 'none', nickname };
    const message = {
      ...welcome,
      tick: 1,
      activities: [{ ...eventHeader(1, 1), kind: 'kill', actor, victim: actor, weapon: 'smg' }],
    };
    assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
  }
  for (const nickname of ['▣ Player', '▣ Bot XX', '<script>', 'A'.repeat(21)]) {
    const frame = snap(1);
    frame.players[0]!.nickname = nickname;
    assert.throws(() => parseServerMessage(JSON.stringify(frame)), /Malformed/);
  }
});

void test('nickname decorations accept only bounded per-character hex colors or defaults', () => {
  for (const value of [undefined, '', 'ff0000------']) assert.ok(validNicknameColors(value, 'AB'));
  for (const value of [null, [], 'red', '#ff0000', 'FF0000------', 'ff0000', 'xxxxxx------'])
    assert.equal(validNicknameColors(value, 'AB'), false);
  const frame = snap(1);
  frame.players[0]!.nicknameColors = 'ff0000'.repeat(frame.players[0]!.nickname.length);
  assert.deepEqual(parseServerMessage(JSON.stringify(frame)), frame);
  frame.players[0]!.nicknameColors = 'red';
  assert.throws(() => parseServerMessage(JSON.stringify(frame)));
});
void test('edits preserve unchanged prefix/suffix colors and give inserted letters defaults', () => {
  assert.equal(editNicknameColors('AB', 'AXB', 'ff00000000ff'), 'ff0000------0000ff');
  assert.equal(editNicknameColors('AXB', 'AB', 'ff0000------0000ff'), 'ff00000000ff');
  assert.equal(editNicknameColors('AB', 'ZB', 'ff00000000ff'), '------0000ff');
  assert.deepEqual(nicknameRuns('ABCD', 'ff0000ff0000------0000ff'), [
    { text: 'AB', color: '#ff0000' },
    { text: 'C', color: '' },
    { text: 'D', color: '#0000ff' },
  ]);
});
