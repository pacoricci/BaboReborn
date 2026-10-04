import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketMeter } from '../../../benchmarks/websocket-meter';

void test('wire accounting handles split headers, fragmented compressed messages and interleaved controls', () => {
  const meter = new WebSocketMeter();
  const handshake = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
  // RSV1 first fragment, ping, continuation; next small uncompressed message.
  const data = Buffer.concat([
    handshake,
    Buffer.from([0x41, 3, 1, 2, 3, 0x89, 1, 9, 0x80, 2, 4, 5, 0x81, 2, 6, 7]),
  ]);
  for (const byte of data) meter.feed(Buffer.from([byte]));
  meter.take('state', 4000);
  meter.take('probe', 2);
  const report = meter.snapshot();
  assert.deepEqual(report.classes.state, { wire: 9, payload: 4000, messages: 1 });
  assert.deepEqual(report.classes.probe, { wire: 4, payload: 2, messages: 1 });
  assert.equal(report.controlBytes, 3);
  assert.equal(report.pendingBytes, 0);
  assert.equal(report.rawBytes, handshake.length + 16);
});

void test('extended frame lengths and unfinished frames reconcile without estimating compressed size', () => {
  const meter = new WebSocketMeter();
  meter.feed(Buffer.from('HTTP/1.1 101 OK\r\n\r\n'));
  for (const size of [130, 65536]) {
    const header = Buffer.alloc(size < 65536 ? 4 : 10);
    header[0] = 0xc1;
    header[1] = size < 65536 ? 126 : 127;
    if (size < 65536) header.writeUInt16BE(size, 2);
    else header.writeBigUInt64BE(BigInt(size), 2);
    meter.feed(header);
    assert.equal(meter.snapshot().pendingBytes, header.length);
    meter.feed(Buffer.alloc(size));
    meter.take('state', size * 2);
  }
  assert.equal(meter.snapshot().classes.state!.wire, 130 + 4 + 65536 + 10);
});
