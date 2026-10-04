import test from 'node:test';
import assert from 'node:assert/strict';
import { JoinRequest } from '../../src/apps/match/join-request';

function harness() {
  const timers: Array<{ action: () => void; delay: number; cancelled: boolean }> = [];
  let changes = 0;
  const join = new JoinRequest(
    (action, delay) => {
      const timer = { action, delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    () => changes++,
  );
  const fire = () => {
    const timer = timers.at(-1)!;
    if (!timer.cancelled) timer.action();
  };
  return { join, timers, fire, changes: () => changes };
}
const spectator = (life: number) => ({ status: 'spectator' as const, life });
const alive = (life: number) => ({ status: 'alive' as const, life });

void test('a confirmed spawn settles the request and cancels its deadline', () => {
  const { join, timers } = harness();
  join.start();
  assert.equal(join.joining, true);
  assert.equal(timers[0]!.delay, 5000);
  assert.equal(join.settle(spectator(1), false), false);
  assert.equal(join.joining, true);
  assert.equal(join.settle(alive(2), false), true);
  assert.equal(join.joining, false);
  assert.equal(timers[0]!.cancelled, true);
});

void test('an unconfirmed spawn times out with a visible problem until the next request', () => {
  const { join, fire, changes } = harness();
  join.start();
  fire();
  assert.equal(join.joining, false);
  assert.match(join.problem, /Spawn not confirmed/);
  assert.equal(changes(), 1);
  join.start();
  assert.equal(join.problem, '');
});

void test('intermission clears a pending request and its problem', () => {
  const { join, fire } = harness();
  join.start();
  fire();
  assert.equal(join.settle(spectator(1), true), false);
  assert.equal(join.problem, '');
  join.start();
  assert.equal(join.settle(spectator(1), true), false);
  assert.equal(join.joining, false);
});

void test('a same-round resync retries only while the original spectator life remains', () => {
  const { join, timers } = harness();
  join.start();
  join.interrupt(3, spectator(4));
  assert.equal(join.joining, false);
  assert.equal(timers[0]!.cancelled, true);
  assert.equal(join.resume(3, spectator(4)), true);
  // The interruption is consumed by the first reinstallation.
  assert.equal(join.resume(3, spectator(4)), false);
});

void test('a same-round resync with a newer life keeps waiting for the spawn confirmation', () => {
  const { join } = harness();
  join.start();
  join.interrupt(3, spectator(4));
  assert.equal(join.resume(3, alive(5)), false);
  assert.equal(join.joining, true);
  assert.equal(join.settle(alive(5), false), true);
});

void test('requests are never retried across maps, welcomes, deaths or without a pending join', () => {
  for (const [round, own] of [
    [4, spectator(4)],
    [undefined, spectator(4)],
    [3, { status: 'dead' as const, life: 4 }],
    [3, undefined],
  ] as const) {
    const { join } = harness();
    join.start();
    join.interrupt(3, spectator(4));
    assert.equal(join.resume(round, own), false);
    assert.equal(join.joining, false);
  }
  const { join } = harness();
  join.interrupt(3, spectator(4));
  assert.equal(join.resume(3, spectator(4)), false);
});

void test('cancel ends a pending request without reporting a problem', () => {
  const { join, timers } = harness();
  join.start();
  join.cancel();
  assert.equal(join.joining, false);
  assert.equal(join.problem, '');
  assert.equal(timers[0]!.cancelled, true);
});
