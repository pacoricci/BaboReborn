import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchPath,
  matchRoom,
  roomReference,
  roomsPath,
  signInPath,
  centralPortal,
} from '../../src/navigation/routes';
const room = 'a'.repeat(32),
  server = 'b'.repeat(32);
void test('room references preserve identity across invitations, rejoin and login', () => {
  const path = matchPath(room, server);
  assert.equal(path, `/rooms/${server}.${room}`);
  assert.equal(matchRoom(new URL(path + '?rejoin=1', 'https://portal.example')), room);
  assert.equal(
    new URL(signInPath(path), 'https://portal.example').searchParams.get('return'),
    path,
  );
  assert.equal(roomsPath(), '/rooms');
  assert.equal(
    new URL(
      roomsPath('authentication_expired', roomReference(server, room)),
      'https://portal.example',
    ).searchParams.get('room'),
    `${server}.${room}`,
  );
  assert.notEqual(roomReference(server, room), roomReference(room, room));
});
void test('invalid and credential-bearing invitation URLs are rejected', () => {
  for (const path of [
    '/rooms/old',
    '/rooms/../ws',
    `/rooms/${server}.${room}?guest=secret`,
    `/rooms/${server}.${room}?rejoin=2`,
    `/rooms/${server}.${room}?rejoin=1&rejoin=1`,
  ])
    assert.throws(() => matchRoom(new URL(path, 'https://portal.example')));
  assert.throws(() => matchPath('https://other.example', server));
  assert.throws(() => roomsPath('closed', 'invalid'));
  assert.equal(centralPortal('https://portal.example/path'), 'https://portal.example/rooms');
  assert.equal(centralPortal('https://user:password@portal.example'), null);
});
