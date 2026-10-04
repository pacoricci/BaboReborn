import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { DeliverySchema } from '../../src/network/generated/snapshot_pb';
import { decodeSnapshotDelivery } from '../../src/network/protobuf';
import { parseDelivery } from '../../src/network/protocol';
import { encodeDelivery } from '../support/encoding';
import { snap } from '../support/online';
import { PROTOCOL } from '../../src/contracts/session';

void test('projection preserves absent proto2 scalars and explicit defaults', () => {
  const message = create(DeliverySchema, {
    kind: 'state',
    body: {
      players: [{ id: 0n, hp: -0, team: '' }],
      match: { round: 0n },
      flags: {},
      items: { delta: true },
    },
  });
  assert.deepEqual(decodeSnapshotDelivery(toBinary(DeliverySchema, message)), {
    kind: 'state',
    body: {
      players: [{ id: 0, hp: -0, team: '' }],
      match: { round: 0 },
      local: null,
      flags: [],
      items: { upsert: [], remove: [] },
    },
  });
  // A generated default is not a supplied required gameplay field.
  assert.throws(() => parseDelivery(toBinary(DeliverySchema, message)));
});

void test('Go Protobuf preserves every binary64 bit in the browser decoder', () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL('../../../backend/server/wire/testdata/protobuf-float64.json', import.meta.url),
      'utf8',
    ),
  ) as { data: string; bits: string[] }[];
  for (const fixture of fixtures) {
    const frame = decodeSnapshotDelivery(Buffer.from(fixture.data, 'base64')) as {
      body: {
        local: { state: { x: number; y: number; angle: number } };
        players: {
          id: number;
          hp: number;
          state: {
            x: number;
            y: number;
            angle: number;
            cooldown: number;
            equipment: {
              charge: number;
              sinceShot: number;
              protection: number;
              meleeDelay: number;
            };
          };
        }[];
      };
    };
    const p = frame.body.players[0]!,
      s = p.state,
      e = s.equipment;
    assert.equal(p.id, Number.MAX_SAFE_INTEGER);
    const values = [
      p.hp,
      frame.body.local.state.x,
      frame.body.local.state.y,
      frame.body.local.state.angle,
      s.cooldown,
      e.charge,
      e.sinceShot,
      e.protection,
      e.meleeDelay,
    ];
    values.forEach((v, i) => {
      const b = new ArrayBuffer(8);
      const view = new DataView(b);
      view.setFloat64(0, v);
      assert.equal(view.getBigUint64(0).toString(16).padStart(16, '0'), fixture.bits[i]);
    });
  }
});
void test('binary snapshots reject truncation, oversized frames, unsafe integers and text fallback', () => {
  const frame = {
    type: 'delivery',
    version: PROTOCOL,
    connection: 'binary',
    sequence: 1,
    generation: 1,
    eventThrough: 0,
    sentAtMs: 100,
    kind: 'state',
    body: {
      ...snap(0),
      items: { upsert: [], remove: [] },
      projectiles: { upsert: [], remove: [] },
    },
  };
  const bytes = encodeDelivery(frame);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(parseDelivery(bytes).kind, 'state');
  assert.equal(parseDelivery(bytes.slice().buffer).kind, 'state');
  assert.throws(() => parseDelivery(JSON.stringify(frame)));
  assert.throws(() => parseDelivery(new Uint8Array(2 * 1024 * 1024 + 1)));
  for (const size of [0, 1, bytes.length - 1])
    assert.throws(() => parseDelivery(bytes.slice(0, size)));
  const message = fromBinary(DeliverySchema, bytes);
  message.sequence = 9007199254740992n;
  assert.throws(() => parseDelivery(toBinary(DeliverySchema, message)));
  message.sequence = 1n;
  message.version = PROTOCOL + 1;
  assert.throws(() => parseDelivery(toBinary(DeliverySchema, message)));
  message.version = PROTOCOL;
  message.body!.players[0]!.state!.angle = 65536;
  assert.throws(() => parseDelivery(toBinary(DeliverySchema, message)));
});
