// Passive server-stream accounting. Classification follows decoded message order,
// while lengths come exclusively from frames BEFORE WebSocket decompression.
import assert from 'node:assert/strict';

export class WebSocketMeter {
  private buffer = Buffer.alloc(0);
  private upgraded = false;
  private messageBytes = 0;
  private messages: number[] = [];
  private classified = 0;
  handshakeBytes = 0;
  rawBytes = 0;
  controlBytes = 0;
  readonly classes: Record<string, { wire: number; payload: number; messages: number }> = {};

  feed(chunk: Buffer): void {
    this.rawBytes += chunk.length;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.upgraded) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        assert.ok(this.buffer.length < 65536, 'Unbounded upgrade response');
        return;
      }
      assert.match(this.buffer.subarray(0, end).toString(), /^HTTP\/1\.1 101 /);
      this.handshakeBytes = end + 4;
      this.buffer = this.buffer.subarray(end + 4);
      this.upgraded = true;
    }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      assert.equal(second & 128, 0, 'Server frames must not be masked');
      let length = second & 127;
      const header = length === 126 ? 4 : length === 127 ? 10 : 2;
      if (this.buffer.length < header) return;
      if (length === 126) length = this.buffer.readUInt16BE(2);
      if (length === 127) {
        const wide = this.buffer.readBigUInt64BE(2);
        assert.ok(wide <= BigInt(2 << 20), 'Frame exceeds delivery budget');
        length = Number(wide);
      }
      if (this.buffer.length < header + length) return;
      const size = header + length;
      if ((first & 15) >= 8) this.controlBytes += size;
      else {
        this.messageBytes += size;
        if (first & 128) {
          this.messages.push(this.messageBytes);
          this.messageBytes = 0;
        }
      }
      this.buffer = this.buffer.subarray(size);
    }
  }

  take(kind: string, payload: number): void {
    const wire = this.messages.shift();
    assert.notEqual(wire, undefined, 'Decoded message has no complete wire frames');
    const group = (this.classes[kind] ??= { wire: 0, payload: 0, messages: 0 });
    group.wire += wire!;
    group.payload += payload;
    group.messages++;
    this.classified += wire!;
  }

  snapshot() {
    const pendingBytes =
      this.buffer.length + this.messageBytes + this.messages.reduce((a, b) => a + b, 0);
    assert.equal(
      this.rawBytes,
      this.handshakeBytes + this.controlBytes + this.classified + pendingBytes,
    );
    return {
      classes: structuredClone(this.classes),
      controlBytes: this.controlBytes,
      pendingBytes,
      rawBytes: this.rawBytes,
      handshakeBytes: this.handshakeBytes,
    };
  }
}
