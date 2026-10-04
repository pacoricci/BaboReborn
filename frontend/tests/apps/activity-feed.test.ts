import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityFeed, activityText } from '../../src/apps/match/activity-feed';
import { parseServerMessage } from '../../src/network/protocol';
import type { Activity } from '../../src/contracts/activity';
import { snap, welcome } from '../support/online';
const kill = (id = 1): Extract<Activity, { kind: 'kill' }> => ({
  id,
  occurredAtMs: Math.floor((100 * 1000) / 120),
  tick: 100,
  round: 1,
  kind: 'kill',
  weapon: 'grenade',
  actor: { id: 1, nickname: 'Alice', team: 'blue' },
  victim: { id: 2, nickname: 'Bob', team: 'red' },
});
void test('feed deduplicates replay, bounds rows and expires against authoritative age', () => {
  const feed = new ActivityFeed();
  feed.receive(
    Array.from({ length: 8 }, (_, i) => kill(i + 1)),
    1,
    1000,
    (220 * 1000) / 120,
  );
  assert.deepEqual(
    feed.visible(1000).map((r) => r.event.id),
    [4, 5, 6, 7, 8],
  );
  feed.receive([kill(8)], 1, 2000, (340 * 1000) / 120);
  assert.equal(feed.visible(9999).length, 5);
  assert.equal(feed.visible(10000).length, 0);
  feed.receive([kill(9)], 1, 11000, (1300 * 1000) / 120);
  assert.equal(feed.visible(11000).length, 0);
  feed.receive([], 2, 11010, (1301 * 1000) / 120);
  assert.equal(feed.visible(11010).length, 0);
});
void test('feed preserves event names and distinguishes suicide', () => {
  const e = kill();
  assert.equal(activityText(e), 'Alice — Grenade → Bob');
  assert.equal(activityText({ ...e, victim: e.actor }), 'Alice eliminated themselves · Grenade');
});
void test('decoder accepts affiliations and rejects malformed event identities and causes', () => {
  const s = { ...welcome, tick: 100, eventCut: 1, activities: [kill()] };
  assert.deepEqual(parseServerMessage(JSON.stringify(s)), s);
  for (const event of [
    { ...kill(), weapon: 'unknown' },
    { ...kill(), tick: 101 },
    { ...kill(), round: 2 },
    { ...kill(), actor: { id: 1, nickname: 'Alice', team: 'green' } },
    { ...kill(), victim: null },
  ]) {
    assert.throws(() => parseServerMessage(JSON.stringify({ ...s, activities: [event] })));
  }
  assert.throws(() =>
    parseServerMessage(JSON.stringify({ ...s, activities: Array(65).fill(kill()) })),
  );
  assert.throws(() => parseServerMessage(JSON.stringify({ ...s, activities: undefined })));
  assert.throws(() => parseServerMessage(JSON.stringify({ ...snap(100), activities: [] })));
});
