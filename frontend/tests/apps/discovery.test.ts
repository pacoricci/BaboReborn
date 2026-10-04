import test from 'node:test';
import assert from 'node:assert/strict';
import { availability, gameProfile, parseServerInfo } from '../../src/network/discovery';
import { PROTOCOL } from '../../src/contracts/session';

void test('discovery blocks mismatched profiles, versions and full rooms', async () => {
  const profile = await gameProfile();
  const info = parseServerInfo({
    schema: 1,
    name: 'Community',
    mode: 'dm',
    map: 'The Yard',
    protocol: PROTOCOL,
    profile,
    occupied: 1,
    capacity: 2,
    details: {
      players: 1,
      bots: 0,
      spectators: 0,
      mapId: 'yard',
      scoreLimit: 20,
      timeLimitSeconds: 600,
    },
  });
  assert.equal(availability(info, profile), null);
  assert.throws(() => parseServerInfo({ ...info, schema: 2 }));
  for (const details of [undefined, null, { ...info.details, players: 2 }])
    assert.throws(() => parseServerInfo({ ...info, details }));
  assert.match(availability({ ...info, protocol: PROTOCOL + 1 }, profile)!, /version/);
  assert.match(availability({ ...info, profile: '0'.repeat(64) }, profile)!, /settings/);
  assert.match(availability({ ...info, occupied: 2 }, profile)!, /full/);
});
void test('untrusted discovery data is bounded before presentation', () => {
  for (const value of [null, {}, { schema: 2 }, { occupied: -1 }])
    assert.throws(() => parseServerInfo(value));
});
