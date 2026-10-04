import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, stepPlayer } from '../../src/core/simulation';
import type { Input, Player } from '../../src/core/simulation';
import { Prediction } from '../../src/prediction/model';
import { compareParityValue } from '../support/prediction-parity';
import { welcome, own, snap } from '../support/online';

function neutralInput(player: Player): Input {
  return {
    x: 0,
    y: 0,
    fire: false,
    aim: { x: player.x + Math.cos(player.angle) * 2, y: player.y + Math.sin(player.angle) * 2 },
  };
}

void test('World → Prediction: synthetic neutral tick filters acknowledgements before replay', () => {
  const initial = createPlayer({ x: 4, y: 4 }, 0);
  initial.cooldown = 0;
  const seed = 1234;
  const p = new Prediction({ ...welcome, id: 5 });
  const remote = { ...own(), id: 5, ack: 40, seed, state: structuredClone(initial) };
  const consumed: Input[] = [
    { x: 1, y: 0, fire: false, aim: { x: 10, y: 4 } },
    { x: 1, y: 0, fire: false, aim: { x: 10, y: 4 } },
    { x: 0, y: 1, fire: false, aim: { x: 10, y: 4 } },
  ];
  const pending: Input[] = [
    { x: -1, y: 0, fire: true, aim: { x: 10, y: 4 } },
    { x: 0, y: -1, fire: false, aim: { x: 10, y: 4 } },
  ];
  assert.ok(p.reconcile(snap(10, remote)));
  for (const input of [...consumed, ...pending]) assert.ok(p.advance(input));
  const before = structuredClone(p.player!);
  const authoritative = structuredClone(initial);
  const authoritySeed = { seed };
  for (const input of [consumed[0]!, consumed[1]!, neutralInput(authoritative), consumed[2]!])
    stepPlayer(authoritative, input, 1 / 120, p.geometry, [], authoritySeed, welcome.shotGeometry);
  assert.equal(authoritySeed.seed, seed, 'authoritative sequence should not consume randomness');
  assert.ok(
    p.reconcile(
      snap(14, {
        ...remote,
        ack: 43,
        seed: authoritySeed.seed,
        state: structuredClone(authoritative),
      }),
      true,
    ),
  );
  const expected = structuredClone(authoritative);
  const replaySeed = { seed: authoritySeed.seed };
  for (const input of pending)
    stepPlayer(expected, input, 1 / 120, p.geometry, [], replaySeed, welcome.shotGeometry);
  compareParityValue(p.player, expected);
  assert.deepEqual(
    p.pending.map((command) => command.seq),
    [44, 45],
    'acknowledged commands were replayed',
  );
  assert.equal(p.seed.seed, replaySeed.seed);
  assert.notEqual(p.seed.seed, authoritySeed.seed, 'pending fire did not advance the replay seed');
  assert.ok(p.correction !== null && p.correction > 0, 'neutral tick did not produce a correction');
  assert.ok(
    Math.abs(p.correction - Math.hypot(expected.x - before.x, expected.y - before.y)) < 1e-12,
    'reported correction differs from the replayed position',
  );
});
