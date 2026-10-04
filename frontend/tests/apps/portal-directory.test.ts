import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog, visibleRooms } from '../../src/apps/play/catalog';
import type { CatalogRoom } from '../../src/apps/play/catalog';
const a = 'a'.repeat(32),
  b = 'b'.repeat(32),
  id = 'c'.repeat(32);
const room: CatalogRoom = {
  ref: `${a}.${id}`,
  id,
  name: 'Arena',
  mode: 'dm',
  map: 'Yard',
  occupied: 1,
  details: {
    players: 0,
    bots: 0,
    spectators: 1,
    mapId: 'yard',
    scoreLimit: 20,
    timeLimitSeconds: 600,
  },
  capacity: 16,
  serverName: 'Community',
  serverOrigin: 'https://game.example',
  region: 'EU',
  updatedAt: new Date(0).toISOString(),
};
const filters = { query: '', mode: '' };
void test('global directory distinguishes identical local IDs and keeps stable names', () => {
  const other = {
    ...room,
    ref: `${b}.${id}`,
    occupied: 16,
    details: { ...room.details, spectators: 16 },
  };
  assert.equal(
    parseCatalog({ schema: 1, rooms: [room, other], updatedAt: room.updatedAt }).rooms.length,
    2,
  );
  assert.equal(visibleRooms([other, room], filters)[0]!.ref, room.ref);
  assert.equal(visibleRooms([other, room], filters).length, 2);
  assert.equal(visibleRooms([room], { ...filters, query: ' ＡＲＥＮＡ ' }).length, 1);
  assert.equal(visibleRooms([room], { ...filters, mode: 'ctf' }).length, 0);
});
void test('the live catalog rejects duplicate references', () => {
  assert.deepEqual(visibleRooms([], filters), []);
  assert.throws(() => parseCatalog({ schema: 2, rooms: [room], updatedAt: room.updatedAt }));
  assert.throws(() => parseCatalog({ schema: 1, rooms: [room, room], updatedAt: room.updatedAt }));
});

void test('catalog separates active humans, bots and spectators and rejects inconsistent totals', () => {
  const detailed = {
    ...room,
    occupied: 5,
    details: {
      players: 2,
      bots: 2,
      spectators: 1,
      mapId: 'yard',
      scoreLimit: 20,
      timeLimitSeconds: 600,
    },
  };
  const parse = (entry: unknown) =>
    parseCatalog({ schema: 1, rooms: [entry], updatedAt: room.updatedAt });
  assert.equal(parse(detailed).rooms[0]!.details.players, 2);
  for (const details of [undefined, null]) assert.throws(() => parse({ ...detailed, details }));
  assert.throws(() => parse({ ...detailed, occupied: 4 }));
  assert.throws(() => parse({ ...detailed, details: { ...detailed.details, bots: -1 } }));
  assert.equal(visibleRooms([room, detailed], { ...filters, withPlayers: true }).length, 1);
  assert.equal(
    visibleRooms([{ ...detailed, occupied: 16, capacity: 16 }], { ...filters, hideFull: true })
      .length,
    0,
  );
});
void test('recommended order prioritizes favorites then available human matches; explicit sorts use measured ping', () => {
  const empty = {
    ...room,
    ref: `${a}.${'d'.repeat(32)}`,
    occupied: 0,
    details: { ...room.details, spectators: 0 },
  };
  const active = {
    ...room,
    ref: `${b}.${id}`,
    details: {
      players: 1,
      bots: 0,
      spectators: 0,
      mapId: 'yard',
      scoreLimit: 10,
      timeLimitSeconds: 300,
    },
    serverOrigin: 'https://fast.example',
  };
  const pings = { [room.serverOrigin]: 90, [active.serverOrigin]: 20 };
  assert.equal(
    visibleRooms([empty, active], { ...filters, favorites: [empty.ref] })[0]!.ref,
    empty.ref,
  );
  assert.equal(visibleRooms([empty, active], filters)[0]!.ref, active.ref);
  assert.equal(
    visibleRooms([empty, active], { ...filters, sort: 'ping', pings })[0]!.ref,
    active.ref,
  );
  assert.equal(visibleRooms([empty, active], { ...filters, sort: 'players' })[0]!.ref, active.ref);
});
