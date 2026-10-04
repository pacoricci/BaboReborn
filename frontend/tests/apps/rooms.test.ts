import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManagedRooms } from '../../src/apps/management/directory';
import { PROTOCOL } from '../../src/contracts/session';

const id = 'a'.repeat(32);
const info = {
  schema: 1,
  name: 'Friends',
  mode: 'dm',
  map: 'The Yard',
  protocol: PROTOCOL,
  profile: 'b'.repeat(64),
  occupied: 0,
  capacity: 2,
  details: {
    players: 0,
    bots: 0,
    spectators: 0,
    mapId: 'yard',
    scoreLimit: 20,
    timeLimitSeconds: 600,
  },
};
const directory = {
  schema: 1,
  rooms: [{ id, info }],
  maps: [{ id: 'yard', name: 'The Yard', ctf: false }],
  maxRooms: 8,
  createdRoomId: id,
};

void test('room replies reject unsafe identities, invalid capacity and unconfirmed creation', () => {
  assert.equal(parseManagedRooms(directory).createdRoomId, id);
  for (const value of [
    null,
    {},
    { ...directory, schema: 2 },
    { ...directory, rooms: [{ id: '../ws', info }] },
    { ...directory, rooms: [{ id: '', info }] },
    {
      ...directory,
      rooms: [
        { id, info },
        { id, info },
      ],
    },
    { ...directory, createdRoomId: 'c'.repeat(32) },
    { ...directory, rooms: [{ id, info: { ...info, capacity: 17 } }] },
    { ...directory, maps: [{ id: '../map', name: 'bad' }] },
    { ...directory, maxRooms: 33 },
  ]) {
    assert.throws(() => parseManagedRooms(value));
  }
});
