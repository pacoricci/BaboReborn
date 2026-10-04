import test from 'node:test';
import assert from 'node:assert/strict';
import { Interpolation } from '../../src/prediction/model';
import { own, snap } from '../support/online';

const snapshotMs = 1000 / 30;
// Synthetic: 30 Hz baseline, 433 ms reception pause, a two-snapshot burst, then recovery.
const arrivals: [received: number, tick: number][] = [
  [0, 0],
  [snapshotMs, 4],
  [2 * snapshotMs, 8],
  [500, 24],
  [500, 28],
  ...Array.from(
    { length: 6 },
    (_, index) => [(16 + index) * snapshotMs, 32 + index * 4] as [number, number],
  ),
];
void test('delayed arrivals and bursts never reverse or jump the shared playback cursor', () => {
  const buffer = new Interpolation();
  let next = 0,
    previous: number | undefined,
    last = 0,
    starved = 0,
    maxRate = 0;
  for (let frame = 0; frame < 44; frame++) {
    const now = (frame * 1000) / 60;
    while (next < arrivals.length && arrivals[next]![0] <= now) {
      const [received, tick] = arrivals[next++]!;
      const player = own();
      player.state.x = tick / 120;
      const state = snap(tick, player);
      state.projectiles = [
        {
          id: 1,
          kind: 'grenade',
          ownerId: 1,
          bornTick: 0,
          motion: 'bounce' as const,
          motionTick: tick,
          attachedId: 0,
          expiresTick: 10000,
          position: { x: tick / 120, y: 0, z: 10 },
          velocity: { x: 1, y: 0, z: 0 },
        },
      ];
      buffer.push(state, received);
    }
    const view = buffer.view(now, 120)!;
    const tick = view.from + (view.to - view.from) * view.alpha;
    if (previous !== undefined) {
      assert.ok(tick >= previous - 1e-9, 'playback reversed');
      assert.ok(tick - previous <= 1.35 * (now - last) * 0.12 + 1e-9, 'burst jumped playback');
    }
    assert.ok(Math.abs(buffer.players(now, 120)[0]!.state.x - tick / 120) < 1e-9);
    assert.ok(Math.abs(buffer.projectiles(now, 120)[0]!.position.x - tick / 120) < 1e-9);
    const diagnostics = buffer.diagnostics(now, 120);
    assert.equal(diagnostics.targetTick, tick);
    assert.deepEqual(buffer.view(now, 120), view, 'repeated reads advanced the cursor');
    starved += Number(diagnostics.starved);
    maxRate = Math.max(maxRate, diagnostics.playbackRate);
    previous = tick;
    last = now;
  }
  assert.equal(next, arrivals.length, 'synthetic schedule was not fully consumed');
  assert.ok(starved >= 20 && starved <= 30, 'delivery pause did not recover promptly');
  assert.ok(maxRate >= 1.34, 'burst did not request bounded catch-up');
  const latest = arrivals.at(-1)![1];
  assert.ok(latest - previous! <= 12, 'recovery left over 100ms of buffered history');
});

void test('round change may restart tick numbering and clears playback debt', () => {
  const buffer = new Interpolation();
  buffer.push(snap(500), 0);
  buffer.view(100, 120);
  const state = snap(0);
  state.match.round = 2;
  buffer.push(state, 110);
  assert.deepEqual(buffer.view(110, 120), { round: 2, from: 0, to: 0, latest: 0, alpha: 0 });
});

void test('attachment transitions use the playback reference, then removal and suspension clear old entities', () => {
  const buffer = new Interpolation();
  const first = snap(100);
  first.projectiles = [
    {
      id: 7,
      kind: 'flame',
      ownerId: 1,
      bornTick: 80,
      expiresTick: 1000,
      attachedId: 0,
      motion: 'fall',
      motionTick: 100,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 1, y: 0, z: 0 },
    },
  ];
  const attached = snap(104);
  attached.projectiles = [
    {
      ...first.projectiles[0]!,
      attachedId: 1,
      motion: 'attached',
      motionTick: 103,
      position: { x: 4, y: 5, z: 0.03 },
      velocity: { x: 0, y: 0, z: 0 },
    },
  ];
  buffer.push(first, 0);
  buffer.push(attached, 1000 / 30);
  // At tick 102 the server has already sent the attachment, but playback has not crossed it.
  const before = buffer.projectiles(1000 / 60, 120, 0)[0]!;
  assert.equal(before.attachedId, 0);
  assert.equal(before.motion, 'fall');
  assert.ok(Math.abs(before.position.x - (1 + 2 / 120)) < 1e-9);
  const after = buffer.projectiles(1000 / 30, 120, 0)[0]!;
  assert.equal(after.attachedId, 1);
  assert.deepEqual(after.position, attached.projectiles[0]!.position);
  assert.deepEqual(buffer.projectiles(2000, 120, 0)[0]!.position, after.position);
  buffer.push(snap(108), 2010);
  assert.deepEqual(buffer.projectiles(2010, 120), [], 'removed entity resurrected');
});
