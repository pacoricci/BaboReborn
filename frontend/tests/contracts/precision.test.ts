import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { create, toBinary } from '@bufbuild/protobuf';
import { DeliverySchema } from '../../src/network/generated/snapshot_pb';
import { decodeSnapshotDelivery } from '../../src/network/protobuf';

void test('Go quantized poses decode with bounded error and exact local checkpoint bits', () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL('../../../backend/server/wire/testdata/protobuf-precision.json', import.meta.url),
      'utf8',
    ),
  ) as { input: number[]; units: number[]; data: string }[];
  for (const fixture of fixtures) {
    const frame = decodeSnapshotDelivery(Buffer.from(fixture.data, 'base64'));
    const player = frame.body.players[0]!.state!;
    const [x, y, angle] = fixture.units as [number, number, number];
    assert.equal(player.x, x / 4096);
    assert.equal(player.y, y / 4096);
    assert.equal(player.angle, (angle >= 32768 ? angle - 65536 : angle) * ((2 * Math.PI) / 65536));
    assert.ok(Math.abs(player.x - fixture.input[0]!) <= 1 / 8192);
    assert.ok(Math.abs(player.y - fixture.input[1]!) <= 1 / 8192);
    const error = player.angle - fixture.input[2]!;
    assert.ok(Math.abs(Math.atan2(Math.sin(error), Math.cos(error))) <= Math.PI / 65536 + 1e-15);
    const local = frame.body.local!.state!;
    assert.deepEqual([local.x, local.y, local.angle], fixture.input);
  }
});

void test('quantized projection preserves missing pose scalars and rejects invalid angle bins', () => {
  const frame = create(DeliverySchema, { kind: 'state', body: { players: [{ state: { x: 0 } }] } });
  assert.deepEqual(decodeSnapshotDelivery(toBinary(DeliverySchema, frame)).body.players[0]!.state, {
    x: 0,
  });
  for (const angle of [65536, 4294967295]) {
    frame.body!.players[0]!.state!.angle = angle;
    assert.throws(() => decodeSnapshotDelivery(toBinary(DeliverySchema, frame)), /quantized angle/);
  }
});
