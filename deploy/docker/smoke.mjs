import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';

const { parseDelivery } = await tsImport('../../frontend/src/network/protocol.ts', import.meta.url);

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = resolve(root, 'deploy/docker');
const output = resolve(root, 'output/docker-smoke');
// Keep bind sources inside the checkout shared with Docker Desktop/Colima.
await mkdir(output, { recursive: true });
for (const name of ['failure.png', 'match.png', 'containers.log'])
  await rm(resolve(output, name), { force: true });
const temporary = await mkdtemp(resolve(output, 'fixture-'));
const project = `baboreborn-smoke-${randomBytes(6).toString('hex')}`;
const offset = Number(process.env.BABOREBORN_DOCKER_PORT_OFFSET ?? 0);
assert(Number.isInteger(offset) && offset >= 0 && offset <= 27000, 'Invalid port offset');
const centralPort = String(38090 + offset);
const serverPort = String(38080 + offset);
const portal = `https://127.0.0.1:${centralPort}`;
const community = `https://127.0.0.1:${serverPort}`;
const environment = {
  ...process.env,
  CENTRAL_IMAGE: process.env.CENTRAL_IMAGE ?? 'baboreborn/central:local',
  SERVER_IMAGE: process.env.SERVER_IMAGE ?? 'baboreborn/server:local',
  CENTRAL_ORIGIN: portal,
  CENTRAL_CONFIG_DIR: resolve(temporary, 'central'),
  SERVER_CONFIG_DIR: resolve(temporary, 'server'),
  POSTGRES_PASSWORD_FILE: resolve(temporary, 'postgres-password'),
  PAIRING_CODE_FILE: '/run/config/pairing-code',
  SMOKE_CENTRAL_PORT: centralPort,
  SMOKE_SERVER_PORT: serverPort,
};
const composeArgs = [
  'compose',
  '--env-file',
  resolve(temporary, 'empty.env'),
  '-p',
  project,
  '-f',
  resolve(files, 'compose.yaml'),
  '-f',
  resolve(files, 'compose.smoke.yaml'),
  '--profile',
  'community',
];

async function run(command, args, input) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, timeout: 180000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) done(stdout);
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr}`));
    });
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}
const compose = (...args) => run('docker', [...composeArgs, ...args]);
const sql = (input) =>
  run(
    'docker',
    [
      ...composeArgs,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'baboreborn',
      '-d',
      'baboreborn',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    input,
  );
const storage = (service, operation, path) =>
  compose(
    'run',
    '--rm',
    '-T',
    '--no-deps',
    service,
    '-data-dir',
    '/data',
    '-storage',
    operation,
    '-backup-file',
    path,
  );

let browser;
let page;
let context;
let started = false;
const failures = [];
const roomName = 'Docker persistence';
let serverID;
let signingKeys;

async function enterRoom(fullMatch = false) {
  await page.goto(`${portal}/rooms`);
  const wire = {
    id: null,
    alive: false,
    intermission: false,
    next: false,
    round: null,
    sent: [],
    connection: null,
    sequence: 0,
    generation: 0,
    confirmedGeneration: 0,
  };
  const listener = (socket) => {
    const url = new URL(socket.url());
    if (url.pathname !== '/ws' || url.searchParams.get('info') === '1') return;
    assert.equal(url.origin, community.replace('https:', 'wss:'));
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      wire.sent.push(message.type);
      if (message.type === 'receipt') {
        assert.equal(message.receipt.connection, wire.connection);
        assert(message.receipt.sequence <= wire.sequence);
        wire.confirmedGeneration = message.receipt.generation;
      }
    });
    socket.on('framereceived', ({ payload }) => {
      const frame = parseDelivery(payload);
      assert.equal(frame.type, 'delivery');
      assert.equal(frame.version, Number(url.searchParams.get('v')));
      wire.connection ??= frame.connection;
      assert.equal(frame.connection, wire.connection);
      assert.equal(frame.sequence, ++wire.sequence);
      assert.equal(frame.generation, wire.generation + Number(frame.kind === 'installation'));
      wire.generation = frame.generation;
      const message = frame.body;
      if (frame.kind === 'installation') wire.id = message.id;
      const state =
        frame.kind === 'installation' ? message.state : frame.kind === 'state' ? message : null;
      if (!state) return;
      const own = state.players.find((player) => player.id === wire.id);
      wire.alive ||= own?.status === 'alive';
      wire.round ??= state.match.round;
      wire.intermission ||= state.match.phase === 'intermission';
      wire.next ||= state.match.round > wire.round;
    });
  };
  page.on('websocket', listener);
  try {
    await page
      .locator('.global-rooms tbody tr')
      .filter({ hasText: roomName })
      .getByRole('button', { name: 'Enter room' })
      .click({ timeout: 45000 });
    await expect(page.locator('#online-menu')).toHaveAttribute('data-state', 'Spectating');
    assert(!wire.sent.includes('join'));
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => wire.alive, { timeout: 15000 }).toBe(true);
    await expect(page.locator('#match-clock')).toBeVisible();
    await expect.poll(() => page.locator('canvas').count()).toBeGreaterThan(0);
    if (fullMatch) {
      console.log('Browser joined over WSS; waiting for the one-minute match and next round.');
      await expect.poll(() => wire.intermission, { timeout: 75000 }).toBe(true);
      await expect.poll(() => wire.next, { timeout: 20000 }).toBe(true);
      await expect.poll(() => wire.confirmedGeneration).toBe(wire.generation);
      await page.screenshot({ path: resolve(output, 'match.png') });
    }
    assert(wire.sent.includes('receipt'), 'The browser must confirm processed deliveries');
    assert.deepEqual(failures, []);
    await page.goto('about:blank');
  } finally {
    page.off('websocket', listener);
  }
}

async function verifyPersistentState() {
  const response = await context.request.get(`${portal}/api/v1/manage/servers`);
  assert.equal(response.status(), 200, 'Account session must persist');
  const servers = await response.json();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, serverID);
  const keys = await context.request.get(`${portal}/identity/v1/keys`);
  assert.equal(keys.status(), 200);
  assert.equal(await keys.text(), signingKeys, 'Signing identity must persist');
  await enterRoom();
}

try {
  await mkdir(output, { recursive: true });
  await mkdir(environment.CENTRAL_CONFIG_DIR, { mode: 0o755 });
  await mkdir(environment.SERVER_CONFIG_DIR, { mode: 0o755 });
  await writeFile(resolve(temporary, 'empty.env'), '');
  const password = randomBytes(24).toString('hex');
  await writeFile(environment.POSTGRES_PASSWORD_FILE, password, { mode: 0o600 });
  await writeFile(
    resolve(temporary, 'central/database-url'),
    `postgres://baboreborn:${password}@postgres:5432/baboreborn?sslmode=disable`,
    { mode: 0o444 },
  );
  for (const name of ['google-client-id', 'google-client-secret'])
    await writeFile(resolve(temporary, 'central', name), '', { mode: 0o444 });
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=BaboReborn container test',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    resolve(temporary, 'central/privkey.pem'),
    '-out',
    resolve(temporary, 'central/fullchain.pem'),
  ]);
  for (const name of ['privkey.pem', 'fullchain.pem']) {
    await chmod(resolve(temporary, 'central', name), 0o444);
    await copyFile(resolve(temporary, 'central', name), resolve(temporary, 'server', name));
  }
  await compose('config', '--quiet');
  // Also validate the independently deployable community file, without central services.
  await run('docker', [
    'compose',
    '--env-file',
    resolve(temporary, 'empty.env'),
    '-f',
    resolve(files, 'compose.server.yaml'),
    'config',
    '--quiet',
  ]);
  started = true;
  console.log('Starting isolated PostgreSQL and release central image.');
  await compose('up', '-d', '--wait', '--wait-timeout', '120', 'postgres');
  await compose(
    'run',
    '--rm',
    '-T',
    '--no-deps',
    'central',
    '-data-dir',
    '/data',
    '-storage',
    'keygen',
  );
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60', 'central');
  const credential = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(credential).digest('hex');
  const account = randomBytes(16).toString('hex');
  const session = randomBytes(16).toString('hex');
  await sql(`INSERT INTO accounts VALUES ('${account}', now());
    INSERT INTO sessions(id,credential_hash,account_id,created_at,expires_at)
    VALUES ('${session}',decode('${hash}','hex'),'${account}',now(),now()+interval '720 hours');`);

  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 960, height: 720 },
  });
  await context.addCookies([
    { name: 'central_session', value: credential, url: portal, httpOnly: true },
  ]);
  const registered = await context.request.post(`${portal}/api/v1/manage/servers`, {
    headers: { Origin: portal },
    data: { name: 'Docker community', region: 'Test', origin: community },
  });
  assert.equal(registered.status(), 200);
  const registration = await registered.json();
  serverID = registration.server.id;
  await writeFile(resolve(temporary, 'server/pairing-code'), registration.code, { mode: 0o444 });
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60', 'server');
  const keys = await context.request.get(`${portal}/identity/v1/keys`);
  assert.equal(keys.status(), 200);
  signingKeys = await keys.text();
  page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  const assets = [];
  page.on('response', (response) => {
    if (response.url().includes('/content/v1/files/')) assets.push(response);
  });
  await page.goto(`${portal}/manage/servers`);
  await page.getByRole('link', { name: 'Manage rooms and access' }).click({ timeout: 45000 });
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name', { exact: true }).fill(roomName);
  await editor.getByLabel('Bots', { exact: true }).fill('0');
  await editor.getByText('Match rules', { exact: true }).click();
  await editor.getByLabel('Minutes', { exact: true }).fill('1');
  await editor.getByRole('button', { name: 'Save room' }).click();
  await expect(editor).not.toBeVisible();
  await enterRoom(true);
  assert(assets.length > 0, 'Rendered match must load central content');
  for (const response of assets) assert(response.ok(), response.url());
  assert.equal((await context.request.get(`${community}/match.html`)).status(), 404);

  console.log('Recreating all containers while preserving volumes and clearing the pairing file.');
  environment.PAIRING_CODE_FILE = '';
  await rm(resolve(temporary, 'server/pairing-code'));
  await compose('down');
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60', 'central');
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60', 'server');
  await verifyPersistentState();

  console.log('Verifying offline PostgreSQL/SQLite backup and restore using the runtime images.');
  await compose('stop', 'server', 'central');
  await storage('central', 'backup', '/data/central.dump');
  await sql('DELETE FROM sessions;');
  await storage('central', 'restore', '/data/central.dump');
  // The test community shares central's loopback namespace, including offline runs.
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60', 'central');
  await storage('server', 'backup', '/data/server-backup.sqlite');
  await storage('server', 'restore', '/data/server-backup.sqlite');
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60', 'server');
  await verifyPersistentState();
  for (const service of ['central', 'server']) {
    assert.equal((await compose('exec', '-T', service, 'id', '-u')).trim(), '10001');
  }
  console.log('PASS: TLS/WSS browser match, next round, recreation, identity and backup/restore.');
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (started) {
        try {
          await writeFile(
            resolve(output, 'containers.log'),
            await compose('logs', '--no-color').catch(String),
          );
        } finally {
          await compose('down', '--volumes', '--remove-orphans');
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
