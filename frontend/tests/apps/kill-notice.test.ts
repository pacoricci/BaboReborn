import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineSession } from '../../src/apps/match/session';
import { own, snap, welcome, batch, eventHeader } from '../support/online';
import type { Activity } from '../../src/contracts/activity';

const kill = (id: number, tick: number, actorID = 1, victimID = 2): Activity => ({
  ...eventHeader(id, tick),
  kind: 'kill',
  actor: { id: actorID, nickname: 'Shooter', team: 'none' },
  victim: { id: victimID, nickname: `Victim ${id}`, team: 'none' },
  weapon: 'smg',
});
function fixture(activities: Activity[] = []) {
  const session = new OnlineSession({ ...welcome, activities });
  session.receive(snap(1), 0, 0);
  function deliver(id: number, tick: number, now: number, actorID = 1, victimID = 2, age = 0) {
    const state = snap(tick);
    state.eventCut = id;
    session.receive(state, now, state.capturedAtMs);
    const delivery = batch(tick, [
      {
        ...eventHeader(id, tick),
        kind: 'activity',
        activity: kill(id, tick, actorID, victimID),
      },
    ]);
    session.receiveEvents(delivery, now, state.capturedAtMs + age);
    return delivery;
  }
  return { session, deliver };
}

void test('personal kill expires; a nearby kill replaces the same notice and advances the chain', () => {
  const { session, deliver } = fixture();
  deliver(1, 120, 1000);
  assert.deepEqual(session.killNotice.visible(1000), {
    revision: 1,
    count: 1,
    label: 'Eliminated',
    victim: 'Victim 1',
    opacity: 1,
  });
  assert.equal(session.killNotice.visible(2500), null);
  deliver(2, 360, 3000);
  assert.equal(session.killNotice.visible(3000)?.label, 'Double kill');
  assert.equal(session.killNotice.visible(3000)?.victim, 'Victim 2');
  assert.equal(session.killNotice.visible(3000)?.revision, 2);
  assert.equal(session.killNotice.visible(3000)?.count, 2);
  deliver(3, 361, 3010);
  assert.equal(session.killNotice.visible(3010)?.label, 'Triple kill');
  deliver(4, 362, 3020);
  assert.equal(session.killNotice.visible(3020)?.label, '4 kills');
  deliver(5, 723, 6030);
  assert.equal(session.killNotice.visible(6030)?.label, 'Eliminated');
});

void test('other kills, suicides, history, stale events and duplicate deliveries do not celebrate', () => {
  const { session, deliver } = fixture([kill(1, 1)]);
  assert.equal(session.killNotice.visible(0), null);
  deliver(1, 120, 1000, 2, 3);
  deliver(2, 121, 1010, 1, 1);
  deliver(3, 122, 1020, 1, 2, 250);
  assert.equal(session.killNotice.visible(1020), null);
  const delivery = deliver(4, 123, 1030);
  session.receiveEvents(delivery, 1400, 1025);
  assert.equal(session.killNotice.visible(1400)?.label, 'Eliminated');
  assert.equal(session.killNotice.visible(2530), null);
});

void test('multikill spacing follows authority time rather than arrival time', () => {
  const { session, deliver } = fixture();
  deliver(1, 120, 1000);
  deliver(2, 481, 1001);
  assert.equal(session.killNotice.visible(1001)?.label, 'Eliminated');
});

void test('respawn and round transition clear the notice and its chain', () => {
  for (const transition of ['respawn', 'round', 'intermission']) {
    const { session, deliver } = fixture();
    deliver(1, 120, 1000);
    const next = snap(121, transition === 'respawn' ? { ...own(), life: 2 } : own());
    next.eventCut = 1;
    if (transition === 'round') next.match.round = 2;
    if (transition === 'intermission') next.match.phase = 'intermission';
    session.receive(next, 1010, next.capturedAtMs);
    assert.equal(session.killNotice.visible(1010), null, transition);
  }
});
