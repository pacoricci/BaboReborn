import test from 'node:test';
import assert from 'node:assert/strict';
import { payloadBytes } from '../../src/network/payload';

void test('application byte counters count UTF-8, including surrogate replacement', () => {
  for (const text of ['', 'snapshot', 'città', '玩家', '🎮', '\ud800', '\udc00', 'x\ud800a🎮z']) {
    assert.equal(
      payloadBytes(text),
      new TextEncoder().encode(text).byteLength,
      JSON.stringify(text),
    );
  }
});
