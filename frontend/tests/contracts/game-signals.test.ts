import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL } from '../../src/contracts/session';
import { parseServerMessage } from '../../src/network/protocol';
import { batch, eventHeader } from '../support/online';

void test('required transitions and cues have independent validated delivery identities', () => {
  const message = batch(
    100,
    [{ ...eventHeader(1, 99), kind: 'signal', signal: 'shield' }],
    [{ ...eventHeader(1, 99), kind: 'bounce' }],
  );
  assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
  for (const change of [
    { signal: 'play-file' },
    { signal: 'bounce' },
    { tick: 101 },
    { ownerId: -1 },
    { position: { x: 4, y: 5 } },
    { id: 0.5 },
    { id: 2 },
  ]) {
    assert.throws(() =>
      parseServerMessage(
        JSON.stringify({ ...message, events: [{ ...message.events[0], ...change }] }),
      ),
    );
  }
  assert.throws(() =>
    parseServerMessage(
      JSON.stringify({ ...message, events: [...message.events, ...message.events] }),
    ),
  );
  assert.throws(() => parseServerMessage(JSON.stringify({ ...message, after: 2 })));
  assert.throws(() => parseServerMessage(JSON.stringify({ ...message, version: PROTOCOL + 1 })));
  assert.throws(() =>
    parseServerMessage(JSON.stringify({ ...message, cues: [{ ...message.cues[0], kind: 'hit' }] })),
  );
});
