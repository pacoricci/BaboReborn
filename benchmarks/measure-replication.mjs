// Sequential A/B measurements: compile/test before running so competing work
// does not contaminate process CPU and scheduling samples.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    baseline: { type: 'string', default: 'output/benchmarks/replication/baseline' },
    central: { type: 'string', default: 'http://127.0.0.1:30090' },
    out: { type: 'string', default: 'output/benchmarks/replication/live' },
    summarize: { type: 'boolean', default: false },
    pairs: { type: 'string', default: '5' },
    scenarios: { type: 'string' },
  },
});
const root = process.cwd(),
  baseline = resolve(values.baseline),
  out = resolve(values.out);
mkdirSync(out, { recursive: true });
const pairCount = Number(values.pairs);
assert.ok(Number.isInteger(pairCount) && pairCount >= 3 && pairCount <= 5);
let configurations = [];
for (const rooms of [1, 4])
  for (const clients of [1, 8, 16])
    configurations.push({ rooms, clients, map: 'yard', compression: 'deflate' });
configurations.push(
  { rooms: 4, clients: 16, map: 'crossing', compression: 'deflate' },
  { rooms: 1, clients: 16, map: 'yard', compression: 'none' },
);
const label = (c) => `${c.map}-r${c.rooms}-c${c.clients}-${c.compression}`;
if (values.scenarios) {
  const requested = values.scenarios.split(',');
  assert.ok(
    requested.every((name) => configurations.some((c) => label(c) === name)),
    'Unknown scenario',
  );
  configurations = configurations.filter((c) => requested.includes(label(c)));
}
const filename = (c, pair, variant) => join(out, `${label(c)}-p${pair}-${variant}.json`);
const environment = {
  ...process.env,
  GOCACHE: process.env.GOCACHE ?? '/private/tmp/baboreborn-go-cache',
};
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const candidate = join(out, 'candidate-server');
async function run(c, pair, variant) {
  const path = filename(c, pair, variant),
    log = path.replace(/\.json$/, '.log');
  const args = [
    '--import',
    'tsx',
    'benchmarks/measure-server-rooms.ts',
    '--source',
    variant === 'baseline' ? join(baseline, 'source') : root,
    '--binary',
    variant === 'baseline' ? join(baseline, 'server') : candidate,
    '--central',
    values.central,
    '--rooms',
    String(c.rooms),
    '--clients',
    String(c.clients),
    '--map',
    c.map,
    '--compression',
    c.compression,
    '--active',
    '--runs',
    '1',
    '--warmup',
    '5',
    '--duration',
    '30',
    '--out',
    path,
  ];
  let output = '';
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', fail);
    child.once('exit', (code) => {
      writeFileSync(log, output);
      if (code === 0) done();
      else fail(new Error(`${variant} ${label(c)} failed: ${output}`));
    });
  });
  const report = JSON.parse(readFileSync(path, 'utf8'));
  return metrics(report);
}
function metrics(report) {
  const run = report.runs[0];
  assert.ok(run);
  const peers = run.rooms.flatMap((r) => r.observers);
  const state = peers.reduce((sum, p) => sum + (p.traffic.state?.wireMbitPerSecond ?? 0), 0);
  const total = peers.reduce(
    (sum, p) => sum + (p.wireBytesIn * 8) / p.observedWallSeconds / 1e6,
    0,
  );
  const invalid = [];
  for (const r of run.rooms) {
    if (r.droppedWallTicks || r.disconnects || r.recoveries || r.rejected)
      invalid.push(`room ${r.id}: drop/disconnect/recovery/rejected`);
    if (
      r.effectiveTickHz < 119 ||
      r.effectiveTickHz > 121 ||
      r.effectiveSnapshotHz < 29.5 ||
      r.effectiveSnapshotHz > 30.5
    )
      invalid.push(`room ${r.id}: cadence`);
  }
  for (const p of peers) {
    if (p.errors.length || p.unexpectedDisconnect) invalid.push('peer errors/disconnect');
    const hz = p.snapshots / p.observedWallSeconds;
    if (hz <= 0 || hz > 30.5) invalid.push('peer snapshot cadence');
    if (!p.playerCounts.length || p.playerCounts.some((n) => n !== 16))
      invalid.push('participant count');
    if (
      p.webSocketExtensions.includes('permessage-deflate') !==
      (report.conditions.compression === 'deflate')
    )
      invalid.push('compression negotiation');
  }
  return {
    state,
    total,
    perClient: state / peers.length,
    cpu: run.serverCPU.percentOfOneCore,
    rss: run.serverRSSBytes.mean,
    snapshotHz:
      peers.reduce((sum, p) => sum + p.snapshots / p.observedWallSeconds, 0) / peers.length,
    minPeerHz: Math.min(...peers.map((p) => p.snapshots / p.observedWallSeconds)),
    skippedStates: peers.reduce((sum, p) => sum + p.missingSnapshots, 0),
    tickP95Micros: run.rooms.reduce((sum, r) => sum + r.tickMicros.p95, 0) / run.rooms.length,
    encodeP95Micros:
      run.rooms.reduce((sum, r) => sum + r.snapshotCaptureEncodeMicros.p95, 0) / run.rooms.length,
    invalid,
    peers: peers.length,
  };
}
function pairInvalid(before, after) {
  const invalid = [...before.invalid, ...after.invalid];
  // Preserve the selected baseline, report any coalesced publications, and
  // require at least its cadence. Two frames cover independent window boundaries.
  if (after.minPeerHz < 29.5 || after.snapshotHz + 2 / 30 < before.snapshotHz)
    invalid.push('candidate delivered fewer updates');
  return invalid;
}
function confidence(values) {
  let seed = 0x173910;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const samples = [];
  for (let n = 0; n < 10000; n++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
    samples.push(sum / values.length);
  }
  samples.sort((a, b) => a - b);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    low: samples[249],
    high: samples[9749],
  };
}
function summarize() {
  const rows = [];
  for (const c of configurations) {
    const pairs = [];
    for (let pair = 1; pair <= pairCount; pair++) {
      const a = filename(c, pair, 'baseline'),
        b = filename(c, pair, 'candidate');
      if (!existsSync(a) || !existsSync(b)) continue;
      pairs.push({
        before: metrics(JSON.parse(readFileSync(a, 'utf8'))),
        after: metrics(JSON.parse(readFileSync(b, 'utf8'))),
      });
    }
    if (!pairs.length) continue;
    const average = (key, side) => pairs.reduce((sum, p) => sum + p[side][key], 0) / pairs.length;
    const state = confidence(pairs.map((p) => p.before.state - p.after.state)),
      total = confidence(pairs.map((p) => p.before.total - p.after.total));
    const invalid = pairs.flatMap((p) => pairInvalid(p.before, p.after));
    rows.push({
      ...c,
      pairs: pairs.length,
      beforeMbit: average('state', 'before'),
      afterMbit: average('state', 'after'),
      beforePerClientMbit: average('state', 'before') / (c.rooms * c.clients),
      afterPerClientMbit: average('state', 'after') / (c.rooms * c.clients),
      beforePerRoomMbit: average('state', 'before') / c.rooms,
      afterPerRoomMbit: average('state', 'after') / c.rooms,
      snapshotSaving: state,
      totalSaving: total,
      percent: (100 * state.mean) / average('state', 'before'),
      beforeTotalMbit: average('total', 'before'),
      afterTotalMbit: average('total', 'after'),
      beforeCPU: average('cpu', 'before'),
      afterCPU: average('cpu', 'after'),
      beforeRSS: average('rss', 'before'),
      afterRSS: average('rss', 'after'),
      beforeSnapshotHz: average('snapshotHz', 'before'),
      afterSnapshotHz: average('snapshotHz', 'after'),
      beforeSkippedStates: average('skippedStates', 'before'),
      afterSkippedStates: average('skippedStates', 'after'),
      cpuDifference: confidence(pairs.map((p) => p.after.cpu - p.before.cpu)),
      rssDifference: confidence(pairs.map((p) => p.after.rss - p.before.rss)),
      tickP95DifferenceMicros: confidence(
        pairs.map((p) => p.after.tickP95Micros - p.before.tickP95Micros),
      ),
      encodeP95DifferenceMicros: confidence(
        pairs.map((p) => p.after.encodeP95Micros - p.before.encodeP95Micros),
      ),
      invalid,
      status:
        pairs.length < pairCount
          ? 'incomplete'
          : invalid.length
            ? 'invalid'
            : state.low > 0 && total.low > 0
              ? 'demonstrated'
              : 'inconclusive',
    });
  }
  const summary = {
    unit: 'Mbit/s (decimal megabits); real incoming TCP stream bytes with WebSocket framing; no TCP/IP or TLS headers',
    bootstrap: { resamples: 10000, seed: 0x173910, confidence: 0.95, paired: true },
    rows,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const table = [
    '| Scenario | Pairs | Snapshot before | Snapshot after | Saved Mbit/s [95% CI] | Saved % | Total before → after | Result |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map(
      (r) =>
        `| ${label(r)} | ${r.pairs} | ${r.beforeMbit.toFixed(3)} | ${r.afterMbit.toFixed(3)} | ${r.snapshotSaving.mean.toFixed(3)} [${r.snapshotSaving.low.toFixed(3)}, ${r.snapshotSaving.high.toFixed(3)}] | ${r.percent.toFixed(1)} | ${r.beforeTotalMbit.toFixed(3)} → ${r.afterTotalMbit.toFixed(3)} | ${r.status} |`,
    ),
  ];
  writeFileSync(join(out, 'summary.md'), table.join('\n') + '\n');
  return rows;
}
if (!values.summarize) {
  assert.ok(
    existsSync(join(baseline, 'manifest.json')) && existsSync(join(baseline, 'source')),
    'The --baseline directory must contain manifest.json and source/',
  );
  const manifest = JSON.parse(readFileSync(join(baseline, 'manifest.json'), 'utf8'));
  assert.equal(sha(join(baseline, 'server')), manifest.serverSHA256, 'Baseline binary changed');
  await exec('go', ['build', '-o', candidate, './backend/cmd/server'], {
    cwd: root,
    env: environment,
  });
  const tracked = await exec(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root },
  );
  const paths = [
    ...new Set(tracked.stdout.split('\0').filter((p) => p && existsSync(join(root, p)))),
  ].sort();
  const inventory = join(out, 'candidate-files.txt'),
    archive = join(out, 'candidate-source.tar.gz');
  writeFileSync(inventory, paths.join('\0') + '\0');
  await exec('tar', ['-czf', archive, '--null', '-T', inventory], { cwd: root });
  const revision = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  const status = await exec('git', ['status', '--short'], { cwd: root });
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify(
      {
        baseline: manifest,
        candidateSHA256: sha(candidate),
        candidateSourceArchive: archive,
        candidateSourceSHA256: sha(archive),
        candidateBaseRevision: revision.stdout.trim(),
        candidateWorkingTree: status.stdout,
        harnessSHA256: sha('benchmarks/measure-server-rooms.ts'),
        driverSHA256: sha('benchmarks/measure-replication.mjs'),
        startedAt: new Date().toISOString(),
        conditions: { pairs: pairCount, warmupSeconds: 5, measuredSeconds: 30, configurations },
      },
      null,
      2,
    ) + '\n',
  );
  for (const c of configurations)
    for (let pair = 1; pair <= pairCount; pair++) {
      const results = {};
      for (const variant of pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
        results[variant] = await run(c, pair, variant);
      summarize();
      console.log(
        JSON.stringify({
          configuration: label(c),
          pair,
          snapshotMbit: [results.baseline.state, results.candidate.state],
          invalid: pairInvalid(results.baseline, results.candidate),
        }),
      );
    }
}
const rows = summarize();
console.log(`Reports: ${out}`);
if (
  rows.length !== configurations.length ||
  rows.some((r) => r.status === 'incomplete' || r.status === 'invalid') ||
  rows
    .filter((r) => r.clients === 16 && r.compression === 'deflate')
    .some((r) => r.status !== 'demonstrated')
)
  process.exitCode = 1;
