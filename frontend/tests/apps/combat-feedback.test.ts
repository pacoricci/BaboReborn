import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatFeedback } from '../../src/apps/match/combat-feedback';
import { OnlineSession } from '../../src/apps/match/session';
import { HeldAction } from '../../src/apps/match/held-action';
import { mapImpact } from '../../src/core/ballistics';
import type { Shot } from '../../src/core/simulation';
import type { Snapshot, EventBatch } from '../../src/contracts/session';
import { own, snap, welcome, batch, eventHeader } from '../support/online';
const shot = (kind = 'smg', hit = false): Shot => ({
  kind,
  from: { x: 4, y: 4, z: 0.3 },
  to: { x: 8, y: 4, z: 0.3 },
  hit,
  killed: false,
  targetId: hit ? 2 : null,
});
function fixture() {
  const log: string[] = [];
  const feedback = new CombatFeedback(
    {
      sustain(kind) {
        log.push(`sustain:${kind}`);
      },
      shot(kind, position) {
        log.push(`sound:${kind}:${position ? 'remote' : 'local'}`);
      },
      sample(kind) {
        log.push(`sample:${kind}`);
      },
      cue(kind) {
        log.push(`cue:${kind}`);
      },
      stop() {
        log.push('stop');
      },
      setListener() {},
    },
    () => ({
      blood(position, damage) {
        log.push(`blood:${position.x},${position.y}:${damage}`);
      },
      clearBlood() {},
      shot(value, id) {
        log.push(`visual:${value.kind}:${id ?? 'local'}`);
      },
      explosion() {
        log.push('explosion');
      },
      reset() {
        log.push('reset-scene');
      },
    }),
  );
  const session = new OnlineSession(welcome);
  const receive = (state: Snapshot, now: number) => {
    const change = session.receive(state, now, state.capturedAtMs);
    if (change) feedback.receive(change, session.prediction.own!);
  };
  const events = (value: EventBatch, now: number, authorityUpper: number) => {
    const change = session.receiveEvents(value, now, authorityUpper);
    feedback.receiveEvents(
      change,
      session.prediction.own!,
      now,
      session.latest!.players,
      session.latest!.match,
    );
    return change;
  };
  receive(snap(1), 0);
  log.length = 0;
  return { log, feedback, session, receive, events };
}
void test('predicted pellets sound once; only a required hit confirms damage', () => {
  const f = fixture(),
    pellets = [shot('shotgun', true), shot('shotgun', true)],
    blast = { ...shot('shotgun'), pellets };
  f.feedback.predicted(blast);
  const state = snap(2);
  state.eventCut = 1;
  f.receive(state, 10);
  const delivery = batch(
    2,
    [{ ...eventHeader(1, 2), kind: 'hit', action: 1 }],
    [
      { ...eventHeader(1, 2), kind: 'shot', shot: blast },
      { ...eventHeader(2, 2), ownerId: 2, kind: 'shot', shot: blast },
      { ...eventHeader(3, 2), kind: 'explosion', radius: 2 },
    ],
  );
  f.events(delivery, 10, state.capturedAtMs);
  assert.equal(f.log.filter((e) => e === 'sound:shotgun:local').length, 1);
  assert.equal(f.log.filter((e) => e === 'visual:shotgun:local').length, 2);
  assert.equal(f.log.filter((e) => e === 'visual:shotgun:2').length, 2);
  assert.equal(f.log.filter((e) => e === 'cue:hit').length, 1);
  const log = [...f.log];
  f.events(delivery, 11, state.capturedAtMs + 1);
  assert.deepEqual(f.log, log);
  const other = fixture();
  other.receive(snap(2), 10);
  other.events(
    batch(2, [], [{ ...eventHeader(1, 2), kind: 'shot', shot: shot('minibot', true) }]),
    10,
    16,
  );
  assert.ok(other.log.includes('sound:minibot:remote'));
  assert.ok(!other.log.includes('cue:hit'), 'visual hit flags cannot confirm a hit');
});
void test('damage survives an omitted hurt snapshot followed by healing; state alone cannot sound damage', () => {
  const f = fixture(),
    healed = snap(20);
  healed.eventCut = 2;
  f.receive(healed, 100);
  assert.equal(f.log.filter((e) => e === 'sample:damage').length, 0);
  const result = f.events(
    batch(20, [
      { ...eventHeader(1, 10), kind: 'damage', amount: 30, weapon: 'smg' },
      { ...eventHeader(2, 15), kind: 'signal', signal: 'pickup-health' },
    ]),
    100,
    healed.capturedAtMs,
  );
  assert.equal(result.accepted.length, 2);
  assert.equal(f.session.prediction.own!.hp, 100);
  assert.ok(f.log.includes('blood:4,4:30'));
  assert.ok(f.log.includes('sample:damage'));
  assert.ok(f.log.includes('sample:pickup-health'));
});
void test('late required facts are consumed without stale audio or extending receive freshness', () => {
  const f = fixture(),
    state = snap(100);
  state.eventCut = 1;
  f.receive(state, 1000);
  const receivedAt = f.session.receivedAt;
  const result = f.events(
    batch(
      10,
      [{ ...eventHeader(1, 10), kind: 'hit', action: 1 }],
      [{ ...eventHeader(1, 10), kind: 'explosion', radius: 2 }],
    ),
    1010,
    state.capturedAtMs + 10,
  );
  assert.equal(result.accepted.length, 1);
  assert.equal(result.events.length, 0);
  assert.equal(result.cues.length, 0);
  assert.equal(f.session.receivedAt, receivedAt);
  assert.deepEqual(f.log, []);
});
void test('death and phase cues are explicit; old-life HUD feedback cannot affect a respawn', () => {
  const f = fixture(),
    dead = snap(10, { ...own(), hp: 0, status: 'dead' });
  dead.eventCut = 2;
  f.receive(dead, 30);
  f.events(
    batch(10, [
      { ...eventHeader(1, 10), kind: 'damage', amount: 100, weapon: 'smg' },
      { ...eventHeader(2, 10), kind: 'death', weapon: 'smg' },
    ]),
    30,
    dead.capturedAtMs,
  );
  assert.ok(f.log.indexOf('sample:damage') < f.log.indexOf('cue:death'));
  const respawn = snap(20, { ...own(), life: 2 });
  respawn.eventCut = 3;
  f.receive(respawn, 60);
  f.events(
    batch(20, [{ ...eventHeader(3, 15), kind: 'hit', action: 1 }], [], 2),
    60,
    respawn.capturedAtMs,
  );
  assert.ok(!f.log.includes('cue:hit'));
  assert.equal(f.feedback.damage.opacity(60), 0);
  const end = snap(21, { ...own(), life: 2 });
  end.match.phase = 'intermission';
  end.eventCut = 4;
  f.receive(end, 70);
  assert.ok(!f.log.includes('cue:round'));
  f.events(
    batch(21, [{ ...eventHeader(4, 21), kind: 'phase', phase: 'intermission' }], [], 3),
    70,
    end.capturedAtMs,
  );
  assert.ok(f.log.includes('sample:round-end'));
});
void test('required activity updates the feed once without replaying baseline history', () => {
  const f = fixture();
  const activity = {
    id: 1,
    tick: 10,
    round: 1,
    occurredAtMs: (100 * 1000) / 120,
    kind: 'flag-take' as const,
    actor: { id: 2, nickname: 'Other', team: 'red' as const },
  };
  const state = snap(10);
  state.eventCut = 1;
  f.receive(state, 50);
  assert.equal(
    f.session.activityFeed.visible(50).length,
    0,
    'a regular state is not live activity',
  );
  const delivery = batch(10, [{ ...eventHeader(1, 10), kind: 'activity', activity }]);
  f.events(delivery, 50, state.capturedAtMs);
  f.events(delivery, 51, state.capturedAtMs + 1);
  assert.equal(f.session.activityFeed.visible(51).length, 1);
  assert.equal(f.log.filter((e) => e === 'sample:flag-take').length, 1);
});
void test('ricochets use surface metadata and aggregate pellets; knives remain spatial cues', () => {
  const f = fixture();
  f.receive(snap(2), 10);
  f.events(
    batch(
      2,
      [],
      [
        {
          ...eventHeader(1, 2),
          kind: 'shot',
          shot: {
            ...shot('shotgun'),
            pellets: [
              { ...shot('shotgun'), surface: true },
              { ...shot('shotgun'), surface: true },
            ],
          },
        },
        { ...eventHeader(2, 2), kind: 'knives', radius: 1 },
      ],
    ),
    10,
    16,
  );
  assert.equal(f.log.filter((e) => e === 'sample:ricochet').length, 1);
  assert.ok(f.log.includes('sample:knives'));
});
void test('secondary tap survives keyup before the simulation, hold repeats, menu clears both', () => {
  const action = new HeldAction();
  action.press();
  action.release();
  assert.equal(action.active, true);
  action.consume();
  assert.equal(action.active, false);
  action.press();
  action.consume();
  assert.equal(action.active, true);
  action.release();
  assert.equal(action.active, false);
  action.press();
  action.clear();
  assert.equal(action.active, false);
});
void test('map collision uses authored height instead of the practice fallback', () => {
  const from = { x: 4, y: 4, z: 1.2 },
    to = { x: 8, y: 4, z: 1.2 };
  for (const height of [1, 3]) {
    const hit = mapImpact(from, to, [{ x: 6, y: 3, w: 1, h: 3, height }], 0.7);
    assert.equal(hit.normal?.x ?? 0, height === 3 ? -1 : 0);
  }
});

void test('coverage uses fresh events for lifecycle, distinct impacts, kills and match results', () => {
  const f = fixture();
  const state = snap(2);
  state.eventCut = 6;
  state.match.ranking = [{ id: 1, team: 'none', score: 1, kills: 1, deaths: 0 }];
  f.receive(state, 10);
  f.events(
    batch(
      2,
      [
        { ...eventHeader(1, 2), kind: 'signal', signal: 'spawn' },
        { ...eventHeader(2, 2), kind: 'signal', signal: 'pickup-grenade' },
        { ...eventHeader(3, 2), kind: 'signal', signal: 'pickup-grenade', ownerId: 2 },
        { ...eventHeader(4, 2), kind: 'death', ownerId: 2, weapon: 'smg' },
        { ...eventHeader(5, 2), kind: 'phase', phase: 'intermission' },
        {
          ...eventHeader(6, 2),
          kind: 'activity',
          activity: {
            ...eventHeader(6, 2),
            kind: 'kill',
            actor: { id: 1, nickname: 'Shooter', team: 'none' },
            victim: { id: 2, nickname: 'Victim', team: 'none' },
            weapon: 'smg',
          },
        },
      ],
      [
        { ...eventHeader(1, 2), kind: 'rocket-explosion', radius: 2 },
        { ...eventHeader(2, 2), kind: 'shot', shot: { ...shot('photon'), surface: true } },
        { ...eventHeader(3, 2), kind: 'shot', shot: { ...shot('flamethrower'), surface: true } },
        { ...eventHeader(4, 2), kind: 'shot', shot: { ...shot('bazooka'), surface: true } },
      ],
    ),
    10,
    state.capturedAtMs,
  );
  for (const kind of [
    'spawn',
    'pickup-grenade',
    'death',
    'victory',
    'rocket-explosion',
    'photon-impact',
    'flame-impact',
  ])
    assert.ok(f.log.includes(`sample:${kind}`), kind);
  assert.equal(f.log.filter((x) => x === 'sample:pickup-grenade').length, 1);
  assert.ok(!f.log.includes('sample:kill'), 'kill confirmation must stay silent');
  assert.equal(f.session.killNotice.visible(10)?.victim, 'Victim');
  assert.ok(f.log.includes('sustain:photon-loop'));
  assert.ok(!f.log.includes('sample:ricochet'), 'rocket launch must not sound its future impact');
  const before = f.log.length;
  f.events(
    batch(2, [{ ...eventHeader(5, 2), kind: 'phase', phase: 'intermission' }], [], 4),
    11,
    state.capturedAtMs,
  );
  assert.equal(f.log.length, before, 'duplicate result does not replay');
});
