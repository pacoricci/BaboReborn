import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServerMessage } from '../../src/network/protocol';
import { own, remote, snap, batch, eventHeader } from '../support/online';

void test('state cannot carry mixed events or physical updates', () => {
  const state = snap(20),
    events = batch(20);
  for (const key of ['events', 'effects', 'signals'])
    assert.throws(() => parseServerMessage(JSON.stringify({ ...state, [key]: [] })));
  const update = { type: 'update', version: state.version, state, events };
  assert.throws(() => parseServerMessage(JSON.stringify(update)));
});

void test('wire enums accept original strings and reject JSON values that stringify to them', () => {
  const state = snap(120);
  const body = {
    motion: 'fixed',
    motionTick: 0,
    id: 1,
    position: { x: 4, y: 4, z: 0.2 },
    velocity: { x: 0, y: 0, z: 0 },
    expiresTick: 240,
  };
  const equipmentMessage = (patch: object) => ({
    ...state,
    local: {
      ...state.local,
      state: { ...own().state, equipment: { ...own().state.equipment, ...patch } },
    },
  });
  const cases = [
    {
      name: 'match.phase',
      values: ['playing', 'intermission'],
      message: (value: unknown) => ({ ...state, match: { ...state.match, phase: value } }),
    },
    {
      name: 'equipment.primaryAction',
      values: ['', 'rocket', 'detonate'],
      message: (value: unknown) => equipmentMessage({ primaryAction: value }),
    },
    {
      name: 'equipment.action',
      values: ['', 'knives', 'shield', 'minibot', 'grenade', 'molotov'],
      message: (value: unknown) => equipmentMessage({ action: value }),
    },
    {
      name: 'item.kind',
      values: ['weapon', 'grenade', 'health'],
      message: (value: unknown) => ({
        ...state,
        items: [
          {
            ...body,
            ...(value === 'weapon' ? { primary: 'smg' } : {}),
            kind: value,
          },
        ],
      }),
    },
    {
      name: 'projectile.kind',
      values: ['grenade', 'molotov', 'flame', 'rocket', 'minibot'],
      message: (value: unknown) => ({
        ...state,
        projectiles: [
          {
            ...body,
            ownerId: 1,
            bornTick: 100,
            attachedId: 0,
            kind: value,
            ...(value === 'minibot' ? { turret: { angle: 0, lastShotTick: 116 } } : {}),
          },
        ],
      }),
    },
    {
      name: 'effect.kind',
      values: ['explosion', 'knives'],
      message: (value: unknown) => ({
        ...batch(120),
        cues: [{ ...eventHeader(1, 120), kind: value, radius: 1 }],
      }),
    },
  ];
  for (const { name, values, message } of cases) {
    for (const value of values) {
      const valid = message(value);
      assert.deepEqual(parseServerMessage(JSON.stringify(valid)), valid, `${name}: ${value}`);
      for (const coerced of [[value], [[value]]]) {
        assert.throws(
          () => parseServerMessage(JSON.stringify(message(coerced))),
          /Malformed/,
          name,
        );
      }
    }
    for (const invalid of [[], null, {}, 0, false, undefined, 'unsupported']) {
      assert.throws(() => parseServerMessage(JSON.stringify(message(invalid))), /Malformed/, name);
    }
  }
});

void test('snapshot rosters count all statuses, allow increasing IDs and reject excess or duplicate entries', () => {
  const players = Array.from({ length: 17 }, (_, i) => ({
    ...remote(own()),
    id: i + 101,
    status: (['spectator', 'alive', 'dead'] as const)[i % 3]!,
  }));
  const ranking = players.map(({ id }) => ({ team: 'none', id, score: -1, kills: -1, deaths: 1 }));
  const state = snap(120);
  for (const length of [0, 1, 16]) {
    const valid = {
      ...state,
      players: players.slice(0, length),
      local: null,
      match: { ...state.match, ranking: ranking.slice(0, length) },
    };
    assert.deepEqual(parseServerMessage(JSON.stringify(valid)), valid);
  }
  for (const invalid of [
    { ...state, players },
    { ...state, players: [players[0], players[0]] },
    { ...state, match: { ...state.match, ranking } },
    { ...state, match: { ...state.match, ranking: [ranking[0], ranking[0]] } },
  ]) {
    assert.throws(() => parseServerMessage(JSON.stringify(invalid)), /Malformed/);
  }
});

void test('frozen intermission standings remain valid after ranked players disconnect', () => {
  const state = snap(120);
  state.players = [{ ...remote(own()), id: 200, status: 'spectator' }];
  state.local = null;
  state.match.phase = 'intermission';
  state.match.endsTick = 1320;
  state.match.ranking = [{ team: 'none', id: 100, score: -1, kills: -1, deaths: 1 }];
  assert.deepEqual(parseServerMessage(JSON.stringify(state)), state);
});

void test('team snapshots validate flag identity, carriers and mode-specific state', () => {
  const state = snap(120);
  state.players = [{ ...remote(own()), team: 'blue', status: 'alive' }];
  state.match.rules.mode = 'ctf';
  state.flags = [
    { team: 'blue', state: 'home', carrierId: 0, position: { x: 4.5, y: 12.5 } },
    { team: 'red', state: 'carried', carrierId: state.players[0]!.id, position: { x: 8, y: 12.5 } },
  ];
  assert.deepEqual(parseServerMessage(JSON.stringify(state)), state);
  for (const patch of [
    { flags: [state.flags[0], state.flags[0]] },
    { flags: [state.flags[0], { ...state.flags[1], carrierId: 999 }] },
    { flags: [state.flags[0], { ...state.flags[1], state: 'home' }] },
    { flags: [state.flags[0], { ...state.flags[1], position: { x: Infinity, y: 2 } }] },
    { flags: [] },
    { match: { ...state.match, rules: { ...state.match.rules, mode: 'dm' } } },
    { players: [{ ...state.players[0], status: 'dead' }] },
  ])
    assert.throws(() => parseServerMessage(JSON.stringify({ ...state, ...patch })));
});
