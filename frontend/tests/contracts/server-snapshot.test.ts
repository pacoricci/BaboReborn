import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROTOCOL } from '../../src/contracts/session';
import { parseServerMessage } from '../../src/network/protocol';
import { SHOTGUN } from '../../src/gameconfig/tuning';

void test('owned server DTOs retain the current empty, arsenal and frozen-ranking wire contract', () => {
  for (const name of ['empty', 'playing', 'intermission']) {
    // Go compares Capture against these versioned bytes, including omitted keys
    // and null/[] distinctions; this assertion also binds them to the real decoder.
    const raw = readFileSync(
      new URL(`../../../backend/server/wire/testdata/v${PROTOCOL}-${name}.json`, import.meta.url),
      'utf8',
    );
    const fixture = JSON.parse(raw) as { state: unknown; events: unknown };
    const stateMessage = parseServerMessage(JSON.stringify(fixture.state));
    const eventMessage = parseServerMessage(JSON.stringify(fixture.events));
    assert.equal(stateMessage.type, 'snapshot');
    assert.equal(eventMessage.type, 'events');
    if (stateMessage.type !== 'snapshot' || eventMessage.type !== 'events') continue;
    const message = { state: stateMessage, events: eventMessage };
    const state = message.state;
    if (name === 'empty') {
      assert.equal(state.players.length, 0);
      assert.equal(message.events.events.length, 0);
    } else {
      assert.equal(
        message.events.cues.filter((c) => c.kind === 'shot')[1]?.shot.pellets?.length,
        SHOTGUN.pellets,
      );
      assert.ok(state.projectiles.some((p) => p.kind === 'minibot' && p.turret));
      if (name === 'intermission') {
        assert.deepEqual(
          state.match.ranking.map((p) => p.id),
          [2, 1],
        );
        assert.deepEqual(
          state.players.map((p) => p.id),
          [1],
        );
      }
    }
  }
});
