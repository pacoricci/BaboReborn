import assert from 'node:assert/strict';
import test from 'node:test';
import { PRIMARIES, SECONDARIES } from '../../src/core/equipment';
import {
  compareParityValue,
  PARITY_TOLERANCE,
  replayPrediction,
} from '../support/prediction-parity';

const replay = replayPrediction();
function checkpoints(id: string) {
  const found = replay.find((result) => result.id === id);
  assert.ok(found, id);
  return found.checkpoints;
}

void test('prediction replays cover the current arsenal ticks and special transitions', () => {
  assert.equal(
    replay.slice(0, 22).reduce((n, c) => n + c.checkpoints.length, 0),
    22_704,
  );
  assert.equal(new Set(replay.map((c) => c.id)).size, replay.length);
  for (const primary of PRIMARIES) {
    assert.ok(
      checkpoints(`${primary}-continuous`).some((c) => c.shot?.kind === primary),
      primary,
    );
  }
  for (const secondary of SECONDARIES) {
    assert.ok(
      checkpoints(`secondary-${secondary}`).some(
        (c) => c.state.equipment.secondaryActivated && c.state.equipment.action === secondary,
      ),
      secondary,
    );
  }

  const photon = checkpoints('photon-partial-charge-throw-lock');
  assert.ok(photon[29]!.state.equipment.charge > 0);
  assert.equal(photon[53]!.state.equipment.charge, photon[29]!.state.equipment.charge);
  assert.equal(photon[54]!.state.equipment.secondaryActivated, true);
  assert.equal(photon[54]!.state.equipment.action, 'molotov');
  assert.ok(photon.slice(55, 354).every((c) => !c.shot));
  assert.ok(photon.some((c) => c.shot && c.state.equipment.charge === 0));

  const chain = checkpoints('chain-overheat-release-recovery');
  const overheated = chain.findIndex((c) => c.state.equipment.overheated);
  assert.ok(overheated >= 0);
  assert.equal(chain[overheated + 1]!.shot, null);
  assert.equal(chain[1499]!.state.equipment.overheated, false);
  assert.ok(chain.slice(1500).some((c) => c.shot));

  const sniper = checkpoints('sniper-scoped-to-unscoped').filter((c) => c.shot);
  assert.deepEqual(
    sniper.map((c) => c.shot!.pellets!.length),
    [3, 2],
  );
  const bazooka = checkpoints('bazooka-detonation-window');
  assert.equal(bazooka[0]!.state.equipment.primaryAction, 'rocket');
  assert.ok(bazooka.slice(1, 30).every((c) => c.state.equipment.primaryAction === ''));
  assert.equal(bazooka[30]!.state.equipment.primaryAction, 'detonate');
  assert.equal(bazooka[31]!.state.equipment.primaryAction, '');
  assert.equal(bazooka[91]!.state.equipment.primaryAction, 'detonate');
  assert.equal(bazooka.filter((c) => c.shot).length, 1);

  const flame = checkpoints('flamethrower-range-reset').filter((c) => c.shot);
  const range = (c: (typeof flame)[number]) =>
    Math.hypot(
      c.shot!.to.x - c.shot!.from.x,
      c.shot!.to.y - c.shot!.from.y,
      c.shot!.to.z - c.shot!.from.z,
    );
  assert.ok(range(flame[0]!) > 7.8);
  assert.ok(range(flame.at(-2)!) <= 1.01);
  assert.ok(range(flame.at(-1)!) > 7.8);
  assert.equal(flame.at(-1)!.state.equipment.fireTime, 0);

  const dual = checkpoints('dual-alternating-muzzle-cover').filter((c) => c.shot);
  assert.deepEqual(
    dual.slice(0, 2).map((c) => c.state.equipment.barrel),
    [1, 0],
  );
  assert.ok(dual[0]!.shot!.from.y < 18 && dual[1]!.shot!.from.y > 18);
  assert.ok(dual.slice(0, 2).every((c) => c.shot!.to.x === 20));

  const shotgun = checkpoints('shotgun-reload-blocks-throws');
  assert.equal(shotgun[510]!.state.equipment.shells, 6);
  assert.ok(
    shotgun
      .slice(516, 870)
      .every(
        (c) =>
          c.state.equipment.action === '' &&
          c.state.equipment.grenades === 2 &&
          c.state.equipment.molotovs === 1,
      ),
  );
  assert.equal(shotgun[870]!.state.equipment.action, 'grenade');
  assert.equal(shotgun[870]!.state.equipment.shells, 0);
  assert.equal(shotgun[990]!.state.equipment.action, 'molotov');
  assert.ok(shotgun.slice(1000, 1110).every((c) => !c.shot));
  assert.ok(shotgun[1110]!.shot);
});

void test('parity comparator rejects missing, extra, reordered or misidentified cases and ticks', () => {
  const expected = replay
    .slice(0, 2)
    .map((r) => ({ ...r, checkpoints: r.checkpoints.slice(0, 2) }));
  assert.equal(compareParityValue(structuredClone(expected), expected), 0);
  for (const mutate of [
    (v: typeof expected) => {
      v.pop();
    },
    (v: typeof expected) => {
      v.push(v[0]!);
    },
    (v: typeof expected) => {
      v.reverse();
    },
    (v: typeof expected) => {
      v[1]!.id = v[0]!.id;
    },
    (v: typeof expected) => {
      v[0]!.checkpoints.pop();
    },
    (v: typeof expected) => {
      v[0]!.checkpoints.push(v[0]!.checkpoints[0]!);
    },
    (v: typeof expected) => {
      v[0]!.checkpoints.reverse();
    },
    (v: typeof expected) => {
      v[0]!.checkpoints[0]!.tick++;
    },
    (v: typeof expected) => {
      v[0]!.checkpoints[0]!.seed++;
    },
    (v: typeof expected) => {
      v[0]!.checkpoints[0]!.shots++;
    },
  ]) {
    const actual = structuredClone(expected);
    mutate(actual);
    assert.throws(() => compareParityValue(actual, expected));
  }
});

void test('parity comparator observes every equipment field and exact JSON shape', () => {
  const expected = replay[0]!.checkpoints[0]!.state;
  for (const [key, value] of Object.entries(expected.equipment)) {
    const changed =
      typeof value === 'number'
        ? value + 0.01
        : typeof value === 'boolean'
          ? !value
          : `${value}-changed`;
    assert.throws(
      () =>
        compareParityValue(
          { ...expected, equipment: { ...expected.equipment, [key]: changed } },
          expected,
        ),
      key,
    );
    const missing = structuredClone(expected);
    Reflect.deleteProperty(missing.equipment, key);
    assert.throws(() => compareParityValue(missing, expected), key);
  }
  assert.throws(() =>
    compareParityValue(
      { ...expected, equipment: { ...expected.equipment, addedInGo: 0 } },
      expected,
    ),
  );
  assert.throws(() => compareParityValue({ ...expected, addedInGo: 0 }, expected));
  assert.throws(() => compareParityValue({ ...expected, x: NaN }, expected));
  assert.throws(() => compareParityValue({ ...expected, x: Infinity }, expected));
  assert.throws(() => compareParityValue({ ...expected, x: String(expected.x) }, expected));
  assert.throws(() =>
    compareParityValue({ ...expected, x: expected.x + PARITY_TOLERANCE * 2 }, expected),
  );
  compareParityValue({ ...expected, x: expected.x + PARITY_TOLERANCE / 2 }, expected);
});

void test('parity comparator observes shot identity, geometry, pellets and emission timing', () => {
  const expected = checkpoints('shotgun-reload-blocks-throws')[0]!;
  assert.ok(expected.shot?.pellets);
  for (const mutate of [
    (v: typeof expected) => {
      v.shot = null;
    },
    (v: typeof expected) => {
      v.shot!.kind = 'smg';
    },
    (v: typeof expected) => {
      v.shot!.hit = true;
    },
    (v: typeof expected) => {
      v.shot!.killed = true;
    },
    (v: typeof expected) => {
      v.shot!.targetId = 1;
    },
    (v: typeof expected) => {
      v.shot!.pellets!.pop();
    },
    (v: typeof expected) => {
      v.shot!.pellets!.reverse();
    },
    (v: typeof expected) => {
      Reflect.deleteProperty(v.shot!, 'pellets');
    },
    (v: typeof expected) => {
      v.shot!.pellets![0]!.to.x += 0.01;
    },
    ...(['from', 'to'] as const).flatMap((end) =>
      (['x', 'y', 'z'] as const).map((axis) => (v: typeof expected) => {
        v.shot![end][axis] += 0.01;
      }),
    ),
  ]) {
    const actual = structuredClone(expected);
    mutate(actual);
    assert.throws(() => compareParityValue(actual, expected));
  }
  const missing = structuredClone(expected);
  Reflect.deleteProperty(missing.shot!, 'targetId');
  assert.throws(() => compareParityValue(missing, expected));
  assert.throws(() =>
    compareParityValue({ ...expected, shot: { ...expected.shot, addedInGo: false } }, expected),
  );
});
