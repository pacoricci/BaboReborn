import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLatency, roomLatency } from '../../src/apps/play/latency';

void test('room probes deduplicate servers, cap concurrency and suspend across page lifecycle', async (t) => {
  let dispose = () => {};
  t.after(() => dispose());
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  let notify!: IntersectionObserverCallback;
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      notify = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  for (const [key, value] of Object.entries({ document, window, IntersectionObserver: Observer })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const calls: { origin: string; signal: AbortSignal; complete(value: number): void }[] = [];
  const latency = roomLatency(
    (origin, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ origin, signal, complete: resolve });
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  dispose = () => latency.dispose();
  const values: (number | undefined)[] = [];
  const elements = Array.from({ length: 7 }, () => ({}) as Element);
  elements.forEach((element, i) =>
    latency.watch(element, `https://server-${Math.max(0, i - 1)}.example`, (value) => {
      values[i] = value;
    }),
  );
  const visible = (count: number) =>
    notify(
      elements.map(
        (target, i) => ({ target, isIntersecting: i < count }) as IntersectionObserverEntry,
      ),
      {} as IntersectionObserver,
    );
  visible(7);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map((c) => c.origin)).size, 4);
  calls[0]!.complete(42);
  await new Promise(setImmediate);
  assert.equal(values[0], 42);
  assert.equal(values[1], 42);
  assert.equal(calls.length, 5);
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise(setImmediate);
  assert.ok(calls.every((c) => c.signal.aborted || c === calls[0]));
  assert.equal(values[0], undefined);
  visible(2);
  assert.equal(calls.length, 5);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls.length, 6);
  // A bfcache pagehide can precede document.hidden: it must still prevent restarts.
  window.dispatchEvent(new Event('pagehide'));
  await new Promise(setImmediate);
  assert.equal(calls.length, 6);
  window.dispatchEvent(new Event('pageshow'));
  assert.equal(calls.length, 7);
  calls[6]!.complete(30);
  await new Promise(setImmediate);
  visible(2);
  assert.equal(calls.length, 7);
  assert.equal(values[0], 30);
});

void test('latency uses the median after socket opening and releases aborted probes', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const sockets: Socket[] = [];
  class Socket {
    onopen = () => {};
    onmessage: (event: { data: string }) => void = () => {};
    onerror = () => {};
    onclose = () => {};
    sent: string[] = [];
    closed = false;
    constructor(readonly url: string | URL) {
      sockets.push(this);
    }
    send(message: string) {
      this.sent.push(message);
    }
    close() {
      this.closed = true;
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'WebSocket', previous);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  });
  const result = measureLatency('https://game.example', new AbortController().signal);
  const socket = sockets[0]!;
  assert.equal(socket.url.toString(), 'wss://game.example/latency');
  now = 10_000;
  socket.onopen();
  for (const duration of [40, 10, 90]) {
    now += duration;
    socket.onmessage({ data: 'pong' });
  }
  assert.equal(await result, 40);
  assert.deepEqual(socket.sent, ['ping', 'ping', 'ping']);
  assert.equal(socket.closed, true);
  const controller = new AbortController();
  const aborted = measureLatency('https://game.example', controller.signal);
  controller.abort();
  await assert.rejects(aborted);
  assert.equal(sockets[1]!.closed, true);
  await assert.rejects(
    measureLatency('https://game.example/elsewhere', new AbortController().signal),
  );
});
