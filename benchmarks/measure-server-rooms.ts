import type * as SessionContract from '../frontend/src/contracts/session';
import type * as ProtocolContract from '../frontend/src/network/protocol';
import type * as SnapshotContract from '../frontend/src/contracts/snapshot';
import { WebSocketMeter } from './websocket-meter';
import WebSocket from 'ws';
// Real loopback transport with independently draining clients and authoritative
// bots completing 16 participants per room. Rendering is measured separately.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Snapshot } from '../frontend/src/contracts/session';
import { gameProfile } from '../frontend/src/network/discovery';
import { parseCatalog } from '../frontend/src/content/validation';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    source: { type: 'string', default: root },
    binary: { type: 'string' },
    clients: { type: 'string', default: '1' },
    active: { type: 'boolean', default: false },
    map: { type: 'string', default: 'yard' },
    central: { type: 'string', default: 'http://127.0.0.1:18090' },
    rooms: { type: 'string', default: '1,4' },
    runs: { type: 'string', default: '3' },
    duration: { type: 'string', default: '15' },
    warmup: { type: 'string', default: '5' },
    'stall-ms': { type: 'string', default: '0' },
    compression: { type: 'string', default: 'deflate' },
    out: { type: 'string', default: 'output/server-rooms.json' },
  },
});
function bounded(value: string, min: number, max: number): number {
  const number = Number(value);
  assert.ok(
    Number.isInteger(number) && number >= min && number <= max,
    `Expected ${min}..${max}: ${value}`,
  );
  return number;
}
const source = resolve(values.source);
const clients = bounded(values.clients, 1, 16);
const frontendSource = join(source, 'frontend/src');
const { PROTOCOL } = (await import(
  pathToFileURL(join(frontendSource, 'contracts/session.ts')).href
)) as typeof SessionContract;
const { parseDelivery } = (await import(
  pathToFileURL(join(frontendSource, 'network/protocol.ts')).href
)) as typeof ProtocolContract;
const { restoreSnapshot } = (await import(
  pathToFileURL(join(frontendSource, 'contracts/snapshot.ts')).href
)) as typeof SnapshotContract;
const roomCounts = values.rooms.split(',').map((value) => bounded(value, 1, 8));
const runs = bounded(values.runs, 1, 5);
const duration = bounded(values.duration, 3, 50);
const warmup = bounded(values.warmup, 1, 30);
const stallMs = bounded(values['stall-ms'], 0, 500);
assert.ok(['none', 'deflate'].includes(values.compression), 'Expected --compression none|deflate');
assert.ok(
  !stallMs || ['darwin', 'linux'].includes(platform()),
  'Stall experiment requires POSIX signals',
);
const profile = await gameProfile();
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const execAsync = promisify(execFile);
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    n: sorted.length,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? 0,
  };
}
async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 8000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, message);
    await wait(10);
  }
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
  return address.port;
}

class Observer {
  readonly socket: WebSocket;
  private readonly transport: Socket;
  private meter = new WebSocketMeter();
  private meterStart = this.meter.snapshot();
  private generation = 0;
  private ownID = 0;
  private seq = 0;
  private inputTimer: ReturnType<typeof setInterval> | undefined;
  private inputStarted = 0;
  private inputsSent = 0;
  private wireReadStart = 0;
  private wireWrittenStart = 0;
  readonly errors: string[] = [];
  readonly maps = new Set<string>();
  readonly primaries = new Set<string>();
  readonly secondaries = new Set<string>();
  private readonly ping: ReturnType<typeof setInterval>;
  private ending = false;
  private round = 0;
  private latest: Snapshot | null = null;
  private receivedAt = 0;
  private lastTick = 0;
  private measurementStarted = 0;
  ready = false;
  disconnected = false;
  bytesIn = 0;
  bytesOut = 0;
  snapshots = 0;
  entitySamples: Record<string, number> = {};
  missingSnapshots = 0;
  snapshotIntervals: number[] = [];
  rtts: number[] = [];
  playerCounts = new Set<number>();
  rules: Snapshot['match']['rules'] | null = null;
  constructor(
    address: URL,
    readonly room: string,
    readonly index: number,
  ) {
    const url = new URL(address);
    url.searchParams.set('room', room);
    url.searchParams.set('v', String(PROTOCOL));
    url.searchParams.set('profile', profile);
    this.transport = createConnection({ host: url.hostname, port: Number(url.port) });
    this.transport.on('data', (chunk: Buffer) => this.meter.feed(chunk));
    this.socket = new WebSocket(url, {
      origin: values.central,
      perMessageDeflate:
        values.compression === 'deflate'
          ? { serverNoContextTakeover: true, clientNoContextTakeover: true }
          : false,
      createConnection: () => this.transport,
    });
    this.socket.on('upgrade', (response) => {
      const extension = String(response.headers['sec-websocket-extensions'] ?? '');
      assert.equal(extension.includes('permessage-deflate'), values.compression === 'deflate');
      if (values.compression === 'deflate') {
        assert.ok(extension.includes('server_no_context_takeover'));
        assert.ok(extension.includes('client_no_context_takeover'));
      }
    });
    this.socket.addEventListener('open', () =>
      this.socket.send(
        JSON.stringify({
          type: 'authenticate',
          version: PROTOCOL,
          guest: (index + 1).toString(16).padStart(32, 'e'),
        }),
      ),
    );
    this.ping = setInterval(() => {
      if (this.socket.readyState !== WebSocket.OPEN) return;
      const data = JSON.stringify({ type: 'ping', version: PROTOCOL, nonce: performance.now() });
      this.bytesOut += Buffer.byteLength(data);
      this.socket.send(data);
    }, 250);
    this.socket.addEventListener('close', () => {
      if (!this.ending) this.disconnected = true;
    });
    this.socket.addEventListener('error', () => this.errors.push('Observer socket error'));
    this.socket.addEventListener('message', (event) => {
      try {
        const data = event.data;
        if (typeof data !== 'string' && !(data instanceof ArrayBuffer) && !Buffer.isBuffer(data))
          throw new Error('Unsupported WebSocket payload');
        const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        this.bytesIn += bytes;
        const parsed = parseDelivery(data);
        this.meter.take(parsed.kind, bytes);
        this.generation = parsed.generation;
        if (parsed.kind === 'installation') this.latest = parsed.body.state;
        const message =
          parsed.kind === 'state' ? restoreSnapshot(parsed.body, this.latest) : parsed.body;
        if (message.type === 'snapshot') this.latest = message;
        if (message.type === 'welcome' || message.type === 'map' || message.type === 'resync') {
          this.round = message.round;
          this.ownID = message.id;
          this.inputStarted = performance.now();
          this.inputsSent = 0;
          this.maps.add(message.arena.id);
        }
        if (message.type === 'pong') this.rtts.push(performance.now() - message.nonce);
        if (message.type === 'snapshot') {
          assert.equal(message.match.round, this.round, 'Snapshot preceded its round map');
          if (!this.rules) {
            this.rules = message.match.rules;
            assert.equal(this.rules.scoreLimit, 0);
            assert.equal(this.rules.timeLimitTicks, 0);
            assert.equal(this.rules.respawnTicks, 120);
            assert.equal(this.rules.forceRespawn, false);
          }
          this.playerCounts.add(message.players.length);
          this.ready = message.players.length === 16;
          this.snapshots++;
          for (const p of message.projectiles)
            this.entitySamples[p.kind] = (this.entitySamples[p.kind] ?? 0) + 1;
          this.entitySamples.pickup = (this.entitySamples.pickup ?? 0) + message.items.length;
          const now = performance.now();
          if (this.receivedAt) this.snapshotIntervals.push(now - this.receivedAt);
          if (this.lastTick) {
            assert.ok(message.tick > this.lastTick, 'Snapshot tick reversed');
            this.missingSnapshots += Math.max(0, (message.tick - this.lastTick) / 4 - 1);
          }
          this.lastTick = message.tick;
          this.receivedAt = now;
          for (const player of message.players) {
            if (player.status !== 'alive') continue;
            this.primaries.add(player.state.equipment.primary);
            this.secondaries.add(player.state.equipment.secondary);
          }
        }
        const receipt = JSON.stringify({
          type: 'receipt',
          version: PROTOCOL,
          receipt: {
            connection: parsed.connection,
            sequence: parsed.sequence,
            generation: parsed.generation,
            eventThrough: parsed.eventThrough,
          },
        });
        this.bytesOut += Buffer.byteLength(receipt);
        this.socket.send(receipt);
        if (values.active && parsed.kind === 'installation') {
          this.send({
            type: 'select',
            primary: [
              'smg',
              'shotgun',
              'dual',
              'chain',
              'sniper',
              'bazooka',
              'photon',
              'flamethrower',
            ][index % 8],
            secondary: ['minibot', 'shield', 'knives'][index % 3],
          });
          this.send({ type: 'join' });
          this.inputTimer ??= setInterval(() => this.drive(), 1000 / 60);
        }
      } catch (error) {
        this.errors.push(String(error));
      }
    });
  }
  private send(message: object) {
    this.socket.send(
      JSON.stringify({ ...message, version: PROTOCOL, generation: this.generation }),
    );
  }
  private drive() {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const own = this.latest?.players.find((p) => p.id === this.ownID);
    if (!own) return;
    const due = Math.min(
      8,
      Math.floor(((performance.now() - this.inputStarted) * 120) / 1000) - this.inputsSent,
    );
    if (own.status !== 'alive') {
      this.inputsSent += Math.max(0, due);
      if (own.status === 'dead') this.send({ type: 'respawn' });
      return;
    }
    const inputs = [];
    for (let n = 0; n < due; n++) {
      const tick = this.inputsSent++;
      const angle = tick / 180 + (this.index * Math.PI) / 4;
      inputs.push({
        seq: ++this.seq,
        life: own.life,
        x: Math.cos(angle),
        y: Math.sin(angle),
        aim: { x: 16 + Math.cos(angle + 1) * 4, y: 16 + Math.sin(angle + 1) * 4 },
        fire: tick % 480 < 360,
        secondary: tick % 240 === 0,
        grenade: tick % 360 === 0,
        molotov: tick % 600 === 0,
      });
    }
    if (inputs.length) this.send({ type: 'input', inputs });
  }
  reset() {
    this.meterStart = this.meter.snapshot();
    this.wireReadStart = this.transport.bytesRead;
    this.wireWrittenStart = this.transport.bytesWritten;
    this.bytesIn = this.bytesOut = this.snapshots = this.missingSnapshots = 0;
    this.receivedAt = this.lastTick = 0;
    this.entitySamples = {};
    this.snapshotIntervals = [];
    this.rtts = [];
    this.playerCounts.clear();
    this.measurementStarted = performance.now();
  }
  report(endedAt: number) {
    // Freeze before asynchronous RSS work so the consumer's window is explicit.
    return {
      observedWallSeconds: (endedAt - this.measurementStarted) / 1000,
      traffic: Object.fromEntries(
        Object.entries(this.meter.snapshot().classes).map(([kind, count]) => {
          const before = this.meterStart.classes[kind] ?? { wire: 0, payload: 0, messages: 0 };
          const wireBytes = count.wire - before.wire;
          return [
            kind,
            {
              wireBytes,
              payloadBytes: count.payload - before.payload,
              messages: count.messages - before.messages,
              wireMbitPerSecond:
                (wireBytes * 8) / ((endedAt - this.measurementStarted) / 1000) / 1e6,
            },
          ];
        }),
      ),
      entitySamples: { ...this.entitySamples },
      accountingStart: this.meterStart,
      accounting: this.meter.snapshot(),
      snapshots: this.snapshots,
      missingSnapshots: this.missingSnapshots,
      payloadBytesIn: this.bytesIn,
      payloadBytesOut: this.bytesOut,
      wireBytesIn: this.transport.bytesRead - this.wireReadStart,
      wireBytesOut: this.transport.bytesWritten - this.wireWrittenStart,
      webSocketExtensions: this.socket.extensions,
      unexpectedDisconnect: this.disconnected,
      errors: [...this.errors],
      playerCounts: [...this.playerCounts],
      maps: [...this.maps],
      primariesObserved: [...this.primaries].sort(),
      secondariesObserved: [...this.secondaries].sort(),
      rules: structuredClone(this.rules),
      snapshotIntervalsMs: distribution(this.snapshotIntervals),
      rttMs: distribution(this.rtts),
    };
  }
  close() {
    this.ending = true;
    clearInterval(this.ping);
    clearInterval(this.inputTimer);
    this.socket.close();
  }
}

interface Metrics {
  ticks: number;
  lateTicks: number;
  bytesIn: number;
  bytesOut: number;
  rejected: number;
  snapshots: number;
  wakes: number;
  catchUpTicks: number;
  overloadWakes: number;
  droppedWallTicks: number;
  droppedWallSeconds: number;
  observedWallSeconds: number;
  disconnects: number;
  recoveries: number;
  tickMicros: number[];
  snapshotMicros: number[];
  wakeLagMicros: number[];
}
async function metrics(address: URL, room: string): Promise<Metrics> {
  const url = new URL('/metrics', address);
  url.protocol = 'http:';
  url.searchParams.set('room', room);
  url.searchParams.set('guest', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, 'Room metrics request failed');
  const data = (await response.json()) as Metrics;
  assert.ok(Number.isFinite(data.droppedWallSeconds), 'Server lacks bounded-clock metrics');
  return data;
}
function summarize(before: Metrics, after: Metrics) {
  const delta = (key: Exclude<keyof Metrics, 'tickMicros' | 'snapshotMicros' | 'wakeLagMicros'>) =>
    after[key] - before[key];
  const ticks = delta('ticks'),
    snapshots = delta('snapshots'),
    wakes = delta('wakes'),
    wall = delta('observedWallSeconds');
  assert.ok(wall > 0 && ticks > 0 && snapshots > 0);
  // Runs are capped at 50 s, below the server's 7,200-tick timing retention.
  assert.ok(
    ticks <= after.tickMicros.length &&
      snapshots <= after.snapshotMicros.length &&
      wakes <= after.wakeLagMicros.length,
    'Timing window exceeded retained samples',
  );
  return {
    observedWallSeconds: wall,
    ticks,
    effectiveTickHz: ticks / wall,
    simulatedSeconds: ticks / 120,
    snapshots,
    effectiveSnapshotHz: snapshots / wall,
    wakes,
    lateWakes: delta('lateTicks'),
    catchUpTicks: delta('catchUpTicks'),
    overloadWakes: delta('overloadWakes'),
    droppedWallTicks: delta('droppedWallTicks'),
    droppedWallSeconds: delta('droppedWallSeconds'),
    tickMicros: distribution(after.tickMicros.slice(-ticks)),
    snapshotCaptureEncodeMicros: distribution(after.snapshotMicros.slice(-snapshots)),
    wakeLagMicros: distribution(after.wakeLagMicros.slice(-wakes)),
    bytesIn: delta('bytesIn'),
    bytesOut: delta('bytesOut'),
    bytesInPerSecond: delta('bytesIn') / wall,
    bytesOutPerSecond: delta('bytesOut') / wall,
    rejected: delta('rejected'),
    disconnects: delta('disconnects'),
    recoveries: delta('recoveries'),
  };
}

const directory = mkdtempSync(join(tmpdir(), 'baboreborn-server-rooms-'));
const binary = values.binary ? resolve(values.binary) : join(directory, 'server');
if (!values.binary)
  execFileSync('go', ['build', '-o', binary, './backend/cmd/server'], {
    cwd: source,
    stdio: 'pipe',
  });
const sourcePaths = [
  ...new Set(
    git([
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'backend',
      'content',
      'go.mod',
      'go.sum',
    ]).split('\n'),
  ),
]
  // Unstaged moves leave deleted paths in Git's cached inventory. Hash the working tree.
  .filter((path) => existsSync(resolve(root, path)))
  .sort();
const report = {
  format: 'baboreborn-server-rooms-v1',
  recordedAt: new Date().toISOString(),
  protocol: PROTOCOL,
  profile,
  sourceDirectory: source,
  revision: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--short']),
  serverBinarySHA256: hash(readFileSync(binary)),
  harnessCheckoutSourceSHA256: hash(
    sourcePaths.map((path) => `${path}\0${hash(readFileSync(resolve(root, path)))}\n`).join(''),
  ),
  harnessSHA256: hash(readFileSync(fileURLToPath(import.meta.url))),
  environment: {
    cpu: cpus()[0]?.model,
    logicalCPUs: cpus().length,
    memoryBytes: totalmem(),
    platform: platform(),
    os: release(),
    node: process.version,
    go: execFileSync('go', ['version'], { encoding: 'utf8' }).trim(),
    browser: 'none',
    rendering: 'none',
    placement: 'one shared development host; IPv4 loopback; separate server and Node processes',
    network: 'no delay, jitter or packet loss injection',
  },
  conditions: {
    roomCounts,
    runs,
    warmupSeconds: warmup,
    requestedDurationSeconds: duration,
    capacityPerRoom: 16,
    botsPerRoom: 16 - clients,
    socketsPerRoom: clients,
    activeClients: values.active,
    botSeedBase: 9109,
    botDecisionHz: 10,
    input: values.active
      ? '120 Hz scripted commands per active client, 60 Hz batches; seeded bots complete the room; 4 Hz ping per socket'
      : 'bots use real authority commands; spectators send 4 Hz ping',
    rotation: [values.map],
    scoreLimit: 0,
    timeLimitSeconds: 0,
    respawnSeconds: 1,
    targetTickHz: 120,
    targetSnapshotHz: 30,
    compression: values.compression,
    wireCounters:
      'TCP stream bytes including WebSocket framing, excluding handshake, TCP/IP headers and TLS',
    maxStepsPerWake: 8,
    inducedStallMs: stallMs,
    stallMechanism: stallMs
      ? 'SIGSTOP/SIGCONT of owned server child at measurement midpoint'
      : 'none',
    memory:
      'server process RSS sampled approximately once per second with ps; no frontend/OS memory attribution',
  },
  runs: [] as Awaited<ReturnType<typeof measure>>[],
};

async function measure(roomCount: number, repetition: number) {
  const port = await freePort();
  const address = new URL(`ws://127.0.0.1:${port}/ws`);
  const dataDirectory = mkdtempSync(join(tmpdir(), 'baboreborn-benchmark-data-'));
  const rooms = JSON.parse(
    execFileSync(
      'go',
      [
        'run',
        './backend/cmd/benchmark-seed',
        '-data-dir',
        dataDirectory,
        '-central',
        values.central,
        '-rooms',
        String(roomCount),
        '-clients',
        String(clients),
        '-map',
        values.map,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  ) as string[];
  const child = spawn(
    binary,
    [
      '-data-dir',
      dataDirectory,
      '-addr',
      `127.0.0.1:${port}`,
      '-central',
      values.central,
      '-development',
      '-max-rooms',
      '8',
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let serverLog = '',
    exited = false,
    startupError = '';
  child.stderr.on('data', (data: Buffer) => {
    serverLog = (serverLog + data.toString()).slice(-4096);
  });
  child.once('error', (error) => {
    startupError = error.message;
  });
  const finished = new Promise<void>((done) =>
    child.once('close', () => {
      exited = true;
      done();
    }),
  );
  const observers: Observer[] = [];
  let monitor: ReturnType<typeof setInterval> | undefined;
  let resume: ReturnType<typeof setTimeout> | undefined;
  let pause: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    if (stopped) {
      child.kill('SIGCONT');
      stopped = false;
    }
    if (!exited) child.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const rss: number[] = [];
  const cpu: { at: number; seconds: number }[] = [];
  const rssErrors: string[] = [];
  let rssPending: Promise<void> | undefined;
  const injected = { requestedMs: stallMs, actualSignalIntervalMs: 0, atWallSeconds: 0 };
  try {
    let healthy = false;
    const deadline = performance.now() + 8000;
    while (!healthy) {
      assert.ok(
        !exited && !startupError && performance.now() < deadline,
        `Server did not start: ${startupError || serverLog}`,
      );
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        const health = (await response.json()) as { protocol: number };
        healthy = response.ok && health.protocol === PROTOCOL;
      } catch {
        /* Listener setup can lag process startup. */
      }
      if (!healthy) await wait(20);
    }
    // Share the central catalog revision across observers before starting measurement.
    const catalogResponse = await fetch(`${values.central}/content/v1/catalog`, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(4000),
    });
    assert.ok(catalogResponse.ok, `Content catalog unavailable: HTTP ${catalogResponse.status}`);
    const catalog = parseCatalog(await catalogResponse.json());
    address.searchParams.set('content', catalog.revision);
    observers.push(
      ...rooms.flatMap((room, roomIndex) =>
        Array.from(
          { length: clients },
          (_, index) => new Observer(address, room, roomIndex * clients + index),
        ),
      ),
    );
    await until(() => {
      assert.ok(
        observers.every((observer) => !observer.errors.length && !observer.disconnected),
        'Observer failed to join',
      );
      return observers.every((observer) => observer.ready);
    }, 'Rooms did not reach 16 participants');
    await wait(warmup * 1000);
    const before = await Promise.all(rooms.map((room) => metrics(address, room)));
    observers.forEach((observer) => observer.reset());
    const started = performance.now();
    const sampleRSS = async () => {
      if (exited || !child.pid) return;
      try {
        const result = await execAsync('ps', ['-o', 'rss=,time=', '-p', String(child.pid)], {
          encoding: 'utf8',
          timeout: 1000,
        });
        const [memory, elapsedCPU] = result.stdout.trim().split(/\s+/);
        const value = Number(memory) * 1024;
        assert.ok(Number.isFinite(value) && value > 0, 'Invalid ps RSS sample');
        rss.push(value);
        assert.ok(elapsedCPU, 'Missing process CPU time');
        const parts = elapsedCPU.split('-');
        const days = parts.length === 2 ? Number(parts[0]) : 0;
        const seconds =
          parts
            .at(-1)!
            .split(':')
            .reduce((sum, part) => sum * 60 + Number(part), 0) +
          days * 86400;
        assert.ok(Number.isFinite(seconds), 'Invalid process CPU time');
        cpu.push({ at: performance.now(), seconds });
      } catch (error) {
        rssErrors.push(String(error));
      }
    };
    await sampleRSS();
    monitor = setInterval(() => {
      if (!rssPending)
        rssPending = sampleRSS().finally(() => {
          rssPending = undefined;
        });
    }, 1000);
    if (stallMs)
      pause = setTimeout(() => {
        if (exited) return;
        stopped = child.kill('SIGSTOP');
        const at = performance.now();
        injected.atWallSeconds = (at - started) / 1000;
        resume = setTimeout(() => {
          child.kill('SIGCONT');
          stopped = false;
          injected.actualSignalIntervalMs = performance.now() - at;
        }, stallMs);
      }, duration * 500);
    await wait(duration * 1000);
    assert.ok(!interrupted, 'Measurement interrupted');
    const after = await Promise.all(rooms.map((room) => metrics(address, room)));
    const endedAt = performance.now();
    const measuredWallSeconds = (endedAt - started) / 1000;
    const observerReports = observers.map((observer) => observer.report(endedAt));
    clearInterval(monitor);
    await rssPending;
    await sampleRSS();
    const measured = {
      roomCount,
      repetition,
      measuredWallSeconds,
      serverCPU: {
        samples: cpu.length,
        seconds: cpu.length > 1 ? cpu.at(-1)!.seconds - cpu[0]!.seconds : null,
        percentOfOneCore:
          cpu.length > 1
            ? ((cpu.at(-1)!.seconds - cpu[0]!.seconds) * 100000) / (cpu.at(-1)!.at - cpu[0]!.at)
            : null,
      },
      inducedStall: injected,
      serverRSSBytes: distribution(rss),
      serverRSSSampleErrors: rssErrors,
      rooms: rooms.map((room, i) => ({
        id: room || 'default',
        ...summarize(before[i]!, after[i]!),
        observers: observerReports.slice(i * clients, (i + 1) * clients),
        observer: observerReports[i * clients]!,
      })),
    };
    console.log(
      JSON.stringify({
        roomCount,
        repetition,
        effectiveTickHz: measured.rooms.map((room) => room.effectiveTickHz),
        droppedWallTicks: measured.rooms.map((room) => room.droppedWallTicks),
        disconnects: measured.rooms.map((room) => room.disconnects),
      }),
    );
    return measured;
  } finally {
    clearInterval(monitor);
    await rssPending;
    clearTimeout(pause);
    clearTimeout(resume);
    if (stopped) child.kill('SIGCONT');
    observers.forEach((observer) => observer.close());
    if (!exited) child.kill('SIGTERM');
    await Promise.race([finished, wait(4000)]);
    if (!exited) {
      child.kill('SIGKILL');
      await finished;
    }
    rmSync(dataDirectory, { recursive: true, force: true });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

try {
  for (const roomCount of roomCounts)
    for (let run = 1; run <= runs; run++) {
      report.runs.push(await measure(roomCount, run));
      const output = resolve(root, values.out);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    }
  for (const run of report.runs)
    for (const room of run.rooms) {
      assert.equal(room.disconnects, 0, 'Transport disconnected a measured client');
      assert.equal(room.rejected, 0, 'Transport rejected measured messages');
      for (const peer of room.observers) {
        assert.equal(peer.unexpectedDisconnect, false);
        assert.deepEqual(peer.errors, []);
        assert.ok(peer.snapshots > 0);
      }
      assert.equal(room.observer.unexpectedDisconnect, false);
      assert.deepEqual(room.observer.errors, []);
      assert.deepEqual(room.observer.playerCounts, [16]);
      assert.ok(room.observer.snapshots > 0, 'Replica did not deliver current state');
      if (stallMs)
        assert.ok(
          room.droppedWallTicks > 0,
          'Induced long stall did not report discarded wall debt',
        );
    }
  console.log(`Saved ${resolve(root, values.out)}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
