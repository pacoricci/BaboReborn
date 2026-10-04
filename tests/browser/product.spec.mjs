import { PROTOCOL } from '../../frontend/src/contracts/session.ts';
import { parseDelivery } from '../../frontend/src/network/protocol.ts';
import { AUDIO_SAMPLES, sampleFiles } from '../../frontend/src/presentation/audio/audio-catalog.ts';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { community, portal, contentOrigin } from './playwright.config.mjs';

const createdRooms = [];
test.afterEach(async ({ browser }, info) => {
  const rooms = createdRooms.splice(0);
  if (!rooms.length) return;
  // Capture the failure before room cleanup redirects the game back to the portal.
  if (info.status !== info.expectedStatus) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const [index, page] of pages.entries()) {
      if (page.isClosed()) continue;
      try {
        await info.attach(`page-${index + 1}-before-cleanup`, {
          body: await page.screenshot({ timeout: 5000 }),
          contentType: 'image/png',
        });
      } catch (error) {
        await info.attach(`page-${index + 1}-capture-error`, {
          body: String(error),
          contentType: 'text/plain',
        });
      }
    }
  }
  // Each case owns its rooms; retained bot rooms otherwise exhaust the server's
  // real room limit and change the load of later networking/browser checks.
  const context = await browser.newContext({ baseURL: portal });
  const page = await context.newPage();
  try {
    await login(page);
    for (const { index, name } of rooms) {
      await page.goto('/manage/servers');
      const listed = page.waitForResponse(
        (response) => response.url().endsWith('/api/v1/admin/rooms') && response.ok(),
      );
      await page
        .locator('#owned-servers .account-card')
        .filter({
          has: page.getByRole('heading', { name: index ? 'Local B' : 'Local A', exact: true }),
        })
        .getByRole('link', { name: 'Manage rooms and access' })
        .click();
      await listed;
      await expect(page.getByRole('button', { name: 'Create room', exact: true })).toBeVisible();
      const room = page.locator('#managed-rooms tbody tr').filter({ hasText: name });
      if (!(await room.count())) continue;
      await room.getByRole('button', { name: 'Close room', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Reason', { exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(room).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});

async function login(page) {
  await page.goto('/auth/login?return=/account');
  await page.getByRole('link', { name: 'Owner', exact: true }).click();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  const cookies = await page.context().cookies(portal);
  expect(cookies.some((cookie) => cookie.name === 'central_session' && cookie.httpOnly)).toBe(true);
}

async function enterRoom(page, index, name, bots = 0) {
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const assets = [];
  page.on('response', (response) => {
    if (
      response.url().startsWith(`${contentOrigin}/content/v1/files/`) &&
      /\.(png|webp|glb)(\?|$)/.test(response.url())
    )
      assets.push(response);
  });
  await page.goto('/manage/servers');
  const server = page.locator('#owned-servers .account-card').filter({
    has: page.getByRole('heading', { name: index ? 'Local B' : 'Local A', exact: true }),
  });
  await expect(server.getByRole('link', { name: 'Manage rooms and access' })).toBeVisible({
    timeout: 40000,
  });
  await server.getByRole('link', { name: 'Manage rooms and access' }).click();
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name', { exact: true }).fill(name);
  await editor.getByLabel('Bots', { exact: true }).fill(String(bots));
  await editor.getByRole('button', { name: 'Save room' }).click();
  await expect(editor).not.toBeVisible();
  createdRooms.push({ index, name });
  await page.goto('/');
  const wire = {
    socket: null,
    id: null,
    states: [],
    sent: [],
    inputs: [],
    snapshots: new Map(),
    frames: [],
    items: [],
    latest: null,
    reusedItems: 0,
    ack: 0,
  };
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.pathname !== '/ws' || url.searchParams.get('info') === '1') return;
    wire.socket = socket;
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      wire.sent.push(message.type);
      if (message.type === 'input') wire.inputs.push(...message.inputs);
    });
    socket.on('framereceived', ({ payload }) => {
      const frame = parseDelivery(payload);
      wire.frames.push(frame);
      const message = frame.body;
      if (message.type === 'welcome') wire.id = message.id;
      if (message.state) {
        wire.latest = message.state;
        wire.items = message.state.items;
        wire.snapshots.set(message.state.tick, message.state);
      }
      if (message.type === 'snapshot') {
        if (message.items === undefined && wire.items.length) wire.reusedItems++;
        if (message.items) {
          const items = new Map(wire.items.map((item) => [item.id, item]));
          for (const id of message.items.remove) items.delete(id);
          for (const item of message.items.upsert) items.set(item.id, item);
          wire.items = [...items.values()];
        }
        const before = wire.latest;
        wire.latest = {
          ...message,
          items: wire.items,
          flags: message.flags ?? before.flags,
          projectiles: message.projectiles
            ? (() => {
                const entities = new Map(before.projectiles.map((entity) => [entity.id, entity]));
                for (const id of message.projectiles.remove) entities.delete(id);
                for (const entity of message.projectiles.upsert) entities.set(entity.id, entity);
                return [...entities.values()];
              })()
            : before.projectiles,
          players: message.players.map((player) => ({
            ...before?.players.find((p) => p.id === player.id),
            ...player,
          })),
          match: { ...before?.match, ...message.match },
        };
        wire.snapshots.set(message.tick, wire.latest);
        const own = message.players.find((player) => player.id === wire.id);
        if (own) {
          wire.states.push(own.status);
          wire.ack = message.local.ack;
        }
      }
    });
  });
  await page
    .locator('.global-rooms tbody tr')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Enter room' })
    .click();
  await expect(page.locator('#join')).toBeEnabled();
  await expect(page.locator('#online-menu')).toHaveAttribute('data-state', 'Spectating');
  await expect.poll(() => wire.states.length).toBeGreaterThan(2);
  expect(wire.states.every((status) => status === 'spectator')).toBe(true);
  const socketURL = new URL(wire.socket.url());
  expect(socketURL.origin).toBe(community(index).replace('http:', 'ws:'));
  expect(socketURL.pathname).toBe('/ws');
  expect(new URL(page.url()).origin).toBe(portal);
  expect(community(index)).not.toBe(portal);
  await expect.poll(() => assets.length).toBeGreaterThan(0);
  for (const asset of assets) {
    expect(asset.ok(), asset.url()).toBe(true);
    expect(await asset.headerValue('access-control-allow-origin')).toBe('*');
  }
  expect(failures).toEqual([]);
  expect((await page.request.get(`${community(index)}/content/v1/catalog`)).status()).toBe(404);
  return wire;
}

async function enableDiagnostics(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Diagnostics' }).click();
  await page.getByRole('checkbox', { name: 'Collect diagnostics', exact: true }).check();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
}

test('multi-rate state stays complete in the browser across omitted groups and recovery', async ({
  page,
}) => {
  test.setTimeout(120000);
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await login(page);
  const wire = await enterRoom(page, 0, 'Pickup replication', 4);
  await enableDiagnostics(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => wire.reusedItems, { timeout: 45000 }).toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        wire.frames.some(
          (frame) => frame.kind === 'state' && frame.body.projectiles?.remove.length > 0,
        ),
      { timeout: 45000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        wire.frames.some(
          (frame) => frame.kind === 'state' && frame.body.match.ranking?.some((p) => p.deaths > 0),
        ),
      { timeout: 45000 },
    )
    .toBe(true);
  const frames = [];
  wire.socket.on('framereceived', ({ payload }) => frames.push(parseDelivery(payload)));
  const verifyExport = async () => {
    const downloaded = page.waitForEvent('download');
    await page.keyboard.press('F8');
    const report = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
    expect(report.protocol).toBe(PROTOCOL);
    expect(report.connected).toBe(true);
    // The JSON export normalizes negative zero from the binary snapshot.
    expect(report.authority).toEqual(
      JSON.parse(JSON.stringify(wire.snapshots.get(report.authority.tick))),
    );
    expect(report.authority.projectiles.every((p) => p.kind !== 'photon')).toBe(true);
    expect(report.authority.local.id).toBe(wire.id);
    expect(report.authority.local.state.vx).toEqual(expect.any(Number));
    expect(report.authority.local.state.equipment.heat).toEqual(expect.any(Number));
    for (const player of report.authority.players) {
      expect(player).not.toHaveProperty('ack');
      expect(player).not.toHaveProperty('seed');
      expect(Object.keys(player.state).sort()).toEqual([
        'angle',
        'cooldown',
        'equipment',
        'x',
        'y',
      ]);
      expect(Object.keys(player.state.equipment).sort()).toEqual([
        'charge',
        'meleeDelay',
        'primary',
        'protection',
        'secondary',
        'shells',
        'sinceShot',
      ]);
    }
    for (const sample of report.timeline.corrections.recent) {
      if (sample.data.kind !== 'reconcile') continue;
      for (const player of sample.data.nearby)
        expect(Object.keys(player.state).sort()).toEqual(['x', 'y']);
    }
  };
  await verifyExport();
  const ordinary = wire.frames.filter((frame) => frame.kind === 'state');
  expect(ordinary.some((frame) => frame.body.projectiles?.remove.length > 0)).toBe(true);
  for (const frame of ordinary) {
    for (const player of frame.body.players) {
      expect(Number.isInteger(player.state.x * 4096)).toBe(true);
      expect(Number.isInteger(player.state.y * 4096)).toBe(true);
      const angleSteps = (player.state.angle * 65536) / (2 * Math.PI);
      expect(Math.abs(angleSteps - Math.round(angleSteps))).toBeLessThan(1e-10);
    }
    const local = frame.body.local;
    const pose = frame.body.players.find((player) => player.id === local.id).state;
    expect(Math.abs(pose.x - local.state.x)).toBeLessThanOrEqual(1 / 8192);
    expect(Math.abs(pose.y - local.state.y)).toBeLessThanOrEqual(1 / 8192);
    const angleError = pose.angle - local.state.angle;
    expect(Math.abs(Math.atan2(Math.sin(angleError), Math.cos(angleError)))).toBeLessThanOrEqual(
      Math.PI / 65536 + 1e-12,
    );
    for (const group of ['items', 'projectiles']) {
      if (frame.body[group] === undefined) continue;
      expect(Array.isArray(frame.body[group])).toBe(false);
      expect(frame.body[group].upsert.every((entity) => entity.motionTick <= frame.body.tick)).toBe(
        true,
      );
    }
  }
  expect(ordinary.some((frame) => frame.body.players.every((p) => p.nickname === undefined))).toBe(
    true,
  );
  expect(
    ordinary.some(
      (frame) => frame.body.match.rules === undefined && frame.body.match.ranking === undefined,
    ),
  ).toBe(true);
  expect(ordinary.some((frame) => frame.body.match.ranking?.some((p) => p.deaths > 0))).toBe(true);
  let lastStandings = -Infinity;
  let phase;
  for (const frame of wire.frames) {
    if (frame.kind === 'installation') {
      lastStandings = frame.sentAtMs;
      phase = frame.body.state.match.phase;
    } else if (frame.kind === 'state') {
      const state = frame.body;
      if (state.match.ranking !== undefined) {
        if (
          state.match.phase === phase &&
          state.match.rules === undefined &&
          state.players.every((p) => p.team === undefined)
        )
          expect(frame.sentAtMs - lastStandings).toBeGreaterThanOrEqual(250);
        lastStandings = frame.sentAtMs;
      }
      phase = state.match.phase;
    }
  }
  await page.evaluate(() => {
    const end = performance.now() + 1000;
    while (performance.now() < end) {
      /* Exercise a new installation generation. */
    }
  });
  await expect
    .poll(() =>
      frames.some((frame) => frame.kind === 'installation' && frame.body.type === 'resync'),
    )
    .toBe(true);
  const recovery = frames.find(
    (frame) => frame.kind === 'installation' && frame.body.type === 'resync',
  );
  expect(Array.isArray(recovery.body.state.items)).toBe(true);
  await expect
    .poll(() =>
      frames.some((frame) => frame.kind === 'state' && frame.generation === recovery.generation),
    )
    .toBe(true);
  await verifyExport();
  const suspendedAt = wire.latest.tick;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await cdp.detach();
  await expect.poll(() => wire.latest.tick).toBeGreaterThan(suspendedAt + 120);
  await verifyExport();
  await page.screenshot({ path: 'output/playwright/multi-rate-replication.png' });
  expect(failures).toEqual([]);
});

test('release match exports recent diagnostics with L, F8 and the settings action', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const add = WebSocket.prototype.addEventListener;
    let held = false;
    let queued = [];
    window.pauseMatchMessages = () =>
      new Promise((resolve) => {
        held = true;
        setTimeout(() => {
          held = false;
          const count = queued.length;
          for (const deliver of queued) deliver();
          queued = [];
          resolve(count);
        }, 150);
      });
    WebSocket.prototype.addEventListener = function (type, listener, options) {
      if (type !== 'message') return add.call(this, type, listener, options);
      return add.call(
        this,
        type,
        (event) => {
          const deliver = () =>
            typeof listener === 'function'
              ? listener.call(this, event)
              : listener.handleEvent(event);
          if (held) queued.push(deliver);
          else deliver();
        },
        options,
      );
    };
  });
  await login(page);
  const wire = await enterRoom(page, 0, 'Browser diagnostics', 2);
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Diagnostics' }).click();
  const collection = page.getByRole('checkbox', { name: 'Collect diagnostics', exact: true });
  await expect(collection).not.toBeChecked();
  await page.getByRole('button', { name: 'Export diagnostics · L', exact: true }).click();
  await expect(page.getByText('Enable diagnostics in Settings', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => wire.ack).toBeGreaterThan(10);
  await page.keyboard.press('l');
  await expect(page.getByText('Enable diagnostics in Settings', { exact: true })).toBeVisible();
  expect(downloads).toHaveLength(0);
  if (!(await collection.isVisible()))
    await page.locator('summary').filter({ hasText: 'Diagnostics' }).click();
  await collection.check();
  await expect(page.getByText('Enable diagnostics in Settings', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const beforeResume = wire.ack;
  await page.getByRole('button', { name: 'Resume match', exact: true }).click();
  await expect.poll(() => wire.ack).toBeGreaterThan(beforeResume + 10);
  expect(await page.evaluate(() => window.pauseMatchMessages())).toBeGreaterThan(0);
  const afterPause = wire.ack;
  await expect.poll(() => wire.ack).toBeGreaterThan(afterPause + 20);
  await page.screenshot({ path: 'output/playwright/interpolation-after-burst.png' });
  const downloaded = page.waitForEvent('download');
  await page.keyboard.down('l');
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^baboreborn-diagnostics-\d+\.json$/);
  const report = JSON.parse(await readFile(await download.path(), 'utf8'));
  await download.saveAs(test.info().outputPath('diagnostics-f8.json'));
  expect(report.format).toBe('baboreborn-match-diagnostics-v1');
  expect(report.payloadBytesIn).toBeGreaterThan(0);
  expect(report.payloadBytesOut).toBeGreaterThan(0);
  expect(report.webSocketExtensions).toContain('permessage-deflate');
  expect(report).not.toHaveProperty('bytesIn');
  expect(report).not.toHaveProperty('bytesOut');
  expect(report.timeline.corrections.thresholdCells).toBe(0.01);
  const details = report.timeline.corrections.recent;
  expect(details.some((s) => s.data.kind === 'advance')).toBe(true);
  const reconciled = details.find((s) => s.data.kind === 'reconcile' && s.data.comparable);
  expect(reconciled).toBeDefined();
  expect(reconciled.data.authoritative.x).toEqual(expect.any(Number));
  expect(reconciled.data.before.x).toEqual(expect.any(Number));
  expect(reconciled.data.after.x).toEqual(expect.any(Number));
  expect(Array.isArray(reconciled.data.replayInputs)).toBe(true);
  expect(Array.isArray(reconciled.data.replayContacts)).toBe(true);
  expect(details.every((s) => s.generation > 0 && Number.isFinite(s.atMs))).toBe(true);
  expect(report.connected).toBe(true);
  expect(report.active).toBe(true);
  expect(report.authority.players.some((player) => player.id === wire.id)).toBe(true);
  expect(report.buildAsset).toMatch(/\/assets\/.*\.js$/);
  expect(report.timeOriginMs).toBeGreaterThan(0);
  for (const kind of ['frame', 'snapshot', 'collection', 'delivery', 'receipt']) {
    const samples = report.timeline.samples.filter((sample) => sample.kind === kind);
    expect(samples.length, kind).toBeGreaterThan(0);
    expect(
      samples.every((sample) => Number.isFinite(sample.atMs)),
      kind,
    ).toBe(true);
  }
  const stateSample = report.timeline.samples.find((s) => s.kind === 'snapshot');
  expect(stateSample.data.connection).toEqual(expect.any(String));
  expect(stateSample.data.sentAtMs).toBeGreaterThanOrEqual(stateSample.data.capturedAtMs);
  const delivered = report.timeline.samples.find((s) => s.kind === 'delivery');
  expect(delivered.data.parseMs).toBeGreaterThanOrEqual(0);
  expect(delivered.data.processingMs).toBeGreaterThanOrEqual(0);
  expect(delivered.data.processedAtMs).toBeGreaterThanOrEqual(delivered.data.receivedAtMs);
  const playbackFrames = report.timeline.samples.filter((s) => s.kind === 'frame');
  for (let i = 1; i < playbackFrames.length; i++) {
    const before = playbackFrames[i - 1],
      after = playbackFrames[i];
    if (before.data.round === after.data.round && after.atMs - before.atMs < 500)
      expect(after.data.interpolationTick).toBeGreaterThanOrEqual(before.data.interpolationTick);
  }
  expect(
    report.timeline.samples.some((sample) => sample.kind === 'frame' && sample.data.active),
  ).toBe(true);
  await page.keyboard.down('l'); // A held key must not download repeatedly.
  await page.keyboard.up('l');
  for (const modifier of ['Control', 'Meta', 'Alt', 'Shift'])
    for (const key of ['l', 'F8']) await page.keyboard.press(`${modifier}+${key}`);
  await expect(page.locator('#online-menu')).toBeHidden();
  // Resync can legitimately send releases between Playwright actions. Check the
  // shortcut's own synchronous dispatch separately from unrelated socket events.
  const synchronousDownload = page.waitForEvent('download');
  const shortcutReleases = await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    let releases = 0;
    WebSocket.prototype.send = function (data) {
      if (JSON.parse(data).type === 'release') releases++;
      return send.call(this, data);
    };
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F8', cancelable: true }));
      return releases;
    } finally {
      WebSocket.prototype.send = send;
    }
  });
  expect(shortcutReleases).toBe(0);
  await synchronousDownload;
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Combat sounds', exact: true }).focus();
  await page.keyboard.press('l'); // Do not intercept keys while editing a control.
  const button = page.getByRole('button', { name: 'Export diagnostics · L', exact: true });
  await expect(button).toHaveAttribute('aria-keyshortcuts', 'L F8');
  expect(downloads).toHaveLength(2);
  await page.screenshot({ path: 'output/playwright/diagnostics-settings.png' });
  const fromButton = page.waitForEvent('download');
  if (!(await collection.isVisible()))
    await page.locator('summary').filter({ hasText: 'Diagnostics' }).click();
  await collection.uncheck();
  await button.click();
  const second = JSON.parse(await readFile(await (await fromButton).path(), 'utf8'));
  expect(second.active).toBe(false);
  expect(second.timeline.collecting).toBe(false);
  expect(second.timeline.stoppedAtMs).toBeGreaterThan(0);
  expect(
    second.timeline.samples.some((sample) => sample.kind === 'frame' && sample.data.active),
  ).toBe(true);
  expect(
    second.timeline.samples.some((sample) => sample.kind === 'frame' && !sample.data.active),
  ).toBe(true);
  expect(downloads).toHaveLength(3);
  const frozenDownload = page.waitForEvent('download');
  await button.click();
  const frozen = JSON.parse(await readFile(await (await frozenDownload).path(), 'utf8'));
  expect(frozen.timeline.samples).toEqual(second.timeline.samples);
  await collection.check();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  if (!(await collection.isVisible()))
    await page.locator('summary').filter({ hasText: 'Diagnostics' }).click();
  await expect(collection).toBeChecked();
  const restoredDownload = page.waitForEvent('download');
  await button.click();
  const restored = JSON.parse(await readFile(await (await restoredDownload).path(), 'utf8'));
  expect(restored.timeline.collecting).toBe(true);
  expect(restored.timeline.samples.some((sample) => sample.kind === 'frame')).toBe(true);
  if (!(await collection.isVisible()))
    await page.locator('summary').filter({ hasText: 'Diagnostics' }).click();
  await collection.uncheck();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  if (!(await collection.isVisible()))
    await page.locator('summary').filter({ hasText: 'Diagnostics' }).click();
  await expect(collection).not.toBeChecked();
});

test('local login, global room entry, watch, then explicit participation', async ({ page }) => {
  await login(page);
  const wire = await enterRoom(page, 1, 'Browser participation');
  const creditsOpened = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Credits (new tab)' }).click();
  const credits = await creditsOpened;
  await expect(credits.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible();
  await credits.close();
  await expect(page.locator('#online-menu')).toHaveAttribute('data-state', 'Spectating');
  await page.screenshot({ path: 'output/playwright/asset-match.png' });
  const fullscreen = page.locator('#fullscreen-toggle');
  await fullscreen.click();
  await expect(fullscreen).toHaveText('Exit full screen · G');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await fullscreen.click();
  await expect(fullscreen).toHaveText('Full screen · G');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await fullscreen.click();
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => document.exitFullscreen());
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#controls-toggle').click();
  const help = page.getByRole('dialog', { name: 'Controls', exact: true });
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(page.locator('#controls-toggle')).toBeFocused();
  await page.locator('#primary').click();
  await page.getByRole('radio', { name: 'Shotgun', exact: true }).check();
  await page.keyboard.press('g');
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('#primary')).toHaveAccessibleName('Primary: Shotgun');
  await expect(page.locator('#primary')).toBeFocused();
  await page.locator('#secondary').click();
  await expect(page.getByRole('radio')).toHaveCount(3);
  await expect(page.getByRole('radio', { name: 'Popup Knives', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Mini Bot', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Instant Shield', exact: true }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('#secondary')).toHaveAccessibleName('Secondary: Instant Shield');
  for (const image of await page.locator('.loadout img').all()) {
    await expect.poll(() => image.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused();
  await expect(page.locator('.menu-footer')).toBeHidden();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('#primary')).toBeFocused();
  expect(wire.sent).not.toContain('join');
  await page.getByRole('button', { name: 'Spectate', exact: true }).click();
  await expect(page.locator('#match-clock')).toBeVisible();
  await expect(page.locator('#online-menu')).toBeHidden();
  const count = wire.states.length;
  await expect.poll(() => wire.states.length).toBeGreaterThan(count + 2);
  expect(wire.states.every((status) => status === 'spectator')).toBe(true);
  expect(wire.sent).not.toContain('join');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => wire.states.includes('alive')).toBe(true);
  await expect(page.locator('#match-clock')).toBeVisible();
  expect(wire.sent).toContain('join');
  await page.keyboard.press('Control+g');
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.down('g');
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('g'); // Holding the shortcut must not toggle again.
  await page.keyboard.up('g');
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('g');
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#online-menu')).toBeHidden();
  await page.keyboard.down('w');
  await page.mouse.move(600, 300);
  await page.mouse.down();
  const releases = wire.sent.filter((type) => type === 'release').length;
  const transitions = [];
  wire.socket.on('framereceived', ({ payload }) => {
    const frame = parseDelivery(payload);
    if (frame.kind === 'installation') transitions.push(frame.body.type);
  });
  await page.keyboard.down('h');
  await expect(help).toBeVisible();
  await page.keyboard.down('h'); // Browser repeat must not close the window.
  await expect(help).toBeVisible();
  await page.keyboard.up('h');
  await page.keyboard.up('w');
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/playing/);
  await expect
    .poll(() => wire.sent.filter((type) => type === 'release').length)
    .toBeGreaterThan(releases);
  const helpSnapshots = wire.states.length;
  await expect.poll(() => wire.states.length).toBeGreaterThan(helpSnapshots + 2);
  await expect(help).toBeVisible();
  await page.screenshot({ path: 'output/playwright/controls-help.png' });
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(page.locator('#online-menu')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/playing/);
  await page.keyboard.press('h');
  await expect(help).toBeVisible();
  await page.keyboard.press('h');
  await expect(help).toBeHidden();
  await page.keyboard.down('m');
  await expect(page.locator('#online-menu')).toBeVisible();
  await page.keyboard.down('m');
  await expect(page.locator('#online-menu')).toBeVisible();
  await page.keyboard.up('m');
  await page.keyboard.press('m');
  await expect(page.locator('#online-menu')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/playing/);
  // Esc and M close the whole menu from sub-panels, even with a focused control.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Combat sounds', exact: true }).focus();
  await page.keyboard.press('m');
  await expect(page.locator('#online-menu')).toBeHidden();
  await page.keyboard.press('m');
  await expect(page.locator('#online-menu')).toBeFocused();
  await expect(page.locator('#primary')).toBeVisible();
  await page.locator('#primary').click();
  await expect(page.getByRole('radio', { name: 'Shotgun', exact: true })).toBeFocused();
  await page.keyboard.press('m');
  await expect(page.locator('#online-menu')).toBeHidden();
  // Clicking the arena closes it too, but a drag that starts inside the menu never does.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const heading = await page.getByRole('heading', { name: 'Settings', exact: true }).boundingBox();
  await page.mouse.move(heading.x + 4, heading.y + 4);
  await page.mouse.down();
  await page.mouse.move(4, 4);
  await page.mouse.up();
  await expect(page.locator('#online-menu')).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(page.locator('#online-menu')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/playing/);
  expect(wire.sent.filter((type) => type === 'join')).toHaveLength(1);
  expect(wire.sent).not.toContain('respawn');
});

test('rendered shot references reach authority and are acknowledged', async ({ page }) => {
  await login(page);
  const wire = await enterRoom(page, 0, 'Browser lag compensation');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => wire.states.includes('alive')).toBe(true);
  await expect.poll(() => wire.snapshots.size).toBeGreaterThan(8);
  // Recovery releases held controls. Fresh presses keep this check about shot
  // references, without requiring an uninterrupted hold across a resync.
  await expect(async () => {
    await page.mouse.click(600, 300, { delay: 150 });
    expect(wire.inputs.filter((input) => input.fire && input.view).length).toBeGreaterThan(10);
  }).toPass({ timeout: 15000 });
  const shots = wire.inputs.filter((input) => input.fire && input.view);
  for (const shot of shots) {
    const view = shot.view;
    expect(view.from).toBeLessThanOrEqual(view.to);
    expect(view.to).toBeLessThanOrEqual(view.latest);
    expect(view.alpha).toBeGreaterThanOrEqual(0);
    expect(view.alpha).toBeLessThanOrEqual(1);
    for (const tick of [view.from, view.to, view.latest]) {
      const state = wire.snapshots.get(tick);
      expect(state, `snapshot ${tick} was actually received`).toBeDefined();
      expect(state.match.round).toBe(view.round);
    }
  }
  await expect.poll(() => wire.ack).toBeGreaterThanOrEqual(shots.at(-1).seq);
  await expect(page.locator('body')).toHaveClass(/playing/);
  await page.screenshot({ path: 'output/playwright/lag-compensation.png' });
});

test('portal logout closes games on both community servers', async ({ page, context }) => {
  await login(page);
  const first = await context.newPage();
  const second = await context.newPage();
  const wires = [
    await enterRoom(first, 0, 'Browser logout A'),
    await enterRoom(second, 1, 'Browser logout B'),
  ];
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Signed out.', { exact: true })).toBeVisible();
  for (const game of [first, second]) {
    await expect(game).toHaveURL(/\/\?notice=authentication_expired/);
    await expect(
      game.getByText('Session expired. You’re browsing as Guest.', { exact: true }),
    ).toBeVisible();
    await expect(game.getByText('Guest', { exact: true })).toBeVisible();
    await expect(game.getByRole('button', { name: 'Continue as guest' })).toHaveCount(0);
  }
  await expect.poll(() => wires.every((wire) => wire.socket.isClosed())).toBe(true);
  // Logout retains a non-credential marker so other pages can distinguish expired access.
  expect(
    (await context.cookies(portal)).find((cookie) => cookie.name === 'central_session')?.value,
  ).toBe('signed-out');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});

test('room catalog search, favorites and separate management', async ({ page }) => {
  const failures = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await login(page);
  await enterRoom(page, 0, 'Browser catalog A');
  await page.goto('/');
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.getByLabel('Search rooms').fill('Browser catalog A');
  const row = page.locator('.global-rooms tbody tr').filter({ hasText: 'Browser catalog A' });
  await expect(row.locator('.room-ping')).toHaveText(/^\d+ ms$/);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Favorite Browser catalog A', exact: true }).click();
  await page.reload();
  await expect(
    row.getByRole('button', { name: 'Favorite Browser catalog A', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Favorites', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Available slots', { exact: true })).toHaveCount(0);
  await expect(row).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Staff', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create room', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect(
    requests.filter((url) => url.startsWith(community(0)) || url.startsWith(community(1))),
  ).toEqual([]);
  await page.getByText('Account', { exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Account and management' })
    .getByRole('link', { name: 'Servers', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Manage servers', exact: true })).toBeVisible();
  await expect(page.locator('#owned-servers .account-card')).toHaveCount(2);
  expect(failures).toEqual([]);
});

test('global skin follows a guest into either community without community content requests', async ({
  page,
  browser,
}) => {
  await login(page);
  const references = [];
  for (const index of [0, 1]) {
    await enterRoom(page, index, `Browser appearance ${index}`);
    references.push(new URL(page.url()).pathname);
  }
  // The owner's setup session is finished; only the guest needs a live arena.
  await page.goto('/');
  const guest = await browser.newContext();
  const player = await guest.newPage();
  const localContent = [],
    images = [],
    errors = [];
  player.on('request', (request) => {
    if (
      [community(0), community(1)].some((origin) => request.url().startsWith(`${origin}/content/`))
    )
      localContent.push(request.url());
  });
  player.on('response', (response) => {
    if (response.url().startsWith(`${contentOrigin}/content/v1/files/`)) images.push(response);
  });
  player.on('pageerror', (error) => errors.push(error.message));
  await player.goto(`${portal}/character`);
  await expect(player.getByText('Guest', { exact: true })).toBeVisible();
  await player.getByLabel('Skin', { exact: true }).selectOption('rings');
  await player.reload();
  await expect(player.getByLabel('Skin', { exact: true })).toHaveValue('rings');
  for (const reference of references) {
    let ownID;
    const appearances = [];
    player.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (url.pathname !== '/ws' || url.searchParams.get('info') === '1') return;
      const metadata = new Map();
      socket.on('framereceived', ({ payload }) => {
        const frame = parseDelivery(payload);
        const message = frame.body;
        if (message.type === 'welcome') ownID = message.id;
        for (const participant of message.state?.players ?? message.players ?? [])
          if (participant.appearance) metadata.set(participant.id, participant.appearance);
        if (message.type === 'snapshot') {
          const own = message.players.find((p) => p.id === ownID && p.status === 'alive');
          if (own) appearances.push(metadata.get(own.id)?.template);
        }
      });
    });
    await player.goto(`${portal}${reference}`);
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => appearances.includes('rings')).toBe(true);
    await expect(player.locator('#match-clock')).toBeVisible();
  }
  expect(localContent).toEqual([]);
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) expect(image.ok(), image.url()).toBe(true);
  expect(errors).toEqual([]);
  await player.route(`${contentOrigin}/content/v1/files/*.png`, (route) => route.abort());
  await player.goto(`${portal}${references[0]}`);
  await expect(
    player.getByText('Game content could not load. Reload to retry.', { exact: true }),
  ).toBeVisible();
  await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeHidden();
  await guest.close();
});

test('delegated staff discover management automatically and revocation removes access', async ({
  page,
  browser,
}) => {
  await login(page);
  await page.goto('/manage/servers');
  const server = page
    .locator('#owned-servers .account-card')
    .filter({ has: page.getByRole('heading', { name: 'Local A', exact: true }) });
  await server.getByRole('link', { name: 'Manage rooms and access' }).click();
  const address = page.url();
  await page.getByRole('button', { name: 'Staff roles', exact: true }).click();
  const form = page.locator('#role-form');
  await form.getByLabel('Account ID', { exact: true }).fill('3'.repeat(32));
  await form.locator('select[name=role]').selectOption('moderator');
  await expect(form.getByLabel('Reason', { exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: 'Review role' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('#role-list')).toContainText('moderator');
  const staffContext = await browser.newContext({ baseURL: portal });
  const staff = await staffContext.newPage();
  await staff.goto('/auth/login?return=/manage/servers');
  await staff.getByRole('link', { name: 'Moderator', exact: true }).click();
  await expect(staff.getByRole('link', { name: 'Manage rooms and access' })).toBeVisible({
    timeout: 30000,
  });
  await staff.getByRole('link', { name: 'Manage rooms and access' }).click();
  await expect(staff.getByRole('heading', { name: 'Local A', exact: true })).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Create room', exact: true })).toHaveCount(0);
  await expect(
    staff.getByRole('heading', { name: 'Players & moderation', exact: true }),
  ).toBeVisible();
  await form.locator('select[name=role]').selectOption('player');
  await expect(form.getByLabel('Reason', { exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: 'Review role' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(staff.getByText('Staff access is required.', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await staff.goto('/manage/servers');
  await expect(staff.getByRole('link', { name: 'Manage rooms and access' })).toHaveCount(0, {
    timeout: 20000,
  });
  await staff.goto(address);
  await expect(
    staff.getByText('This room or server is unavailable. Please retry later.', { exact: false }),
  ).toBeVisible();
  await staffContext.close();
});

test('catalog supports mobile keyboard navigation and keeps focused controls across refresh', async ({
  page,
}) => {
  await login(page);
  await enterRoom(page, 0, 'Browser mobile keyboard');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const search = page.getByLabel('Search rooms');
  await expect(search).toBeVisible();
  await search.focus();
  await search.fill('Browser');
  await expect.poll(() => page.locator('.global-rooms tbody tr').count()).toBeGreaterThan(0);
  const first = page.locator('.global-rooms tbody tr').first();
  await first.getByRole('button', { name: /Favorite / }).focus();
  await page.waitForResponse((r) => r.url() === portal + '/api/v1/rooms' && r.ok());
  await expect(first.getByRole('button', { name: /Favorite / })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/catalog-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await search.fill('');
  await page.screenshot({ path: 'output/playwright/catalog-desktop.png', fullPage: true });
});

for (const expired of [false, true]) {
  test(`Guest enters directly with ${expired ? 'an expired' : 'no'} account session`, async ({
    page,
    context,
  }) => {
    await login(page);
    const name = `Guest default ${expired ? 'expired' : 'fresh'}`;
    await enterRoom(page, 0, name);
    await page.goto('/account');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    if (!expired) await context.clearCookies();
    await page.goto('/');
    await expect(page.getByText('Guest', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('details.account-summary')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue as guest' })).toHaveCount(0);
    await page.setViewportSize({ width: 819, height: 964 });
    await page.getByLabel('Search rooms').fill(name);
    await page.screenshot({ path: `output/playwright/guest-${expired ? 'expired' : 'fresh'}.png` });
    const identity = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/v1/me',
    );
    await page
      .locator('.global-rooms tbody tr')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Enter room' })
      .click();
    const request = await identity;
    expect(request.headers()['x-guest-id']).toMatch(/^[a-f0-9]{32}$/);
    expect(request.headers().authorization).toBeUndefined();
    await expect(page.locator('#join')).toBeEnabled();
    await expect(page.locator('#online-menu')).toHaveAttribute('data-state', 'Spectating');
  });
}

test('activity events stay visible once across a history-only installation and recovery', async ({
  page,
  browser,
}) => {
  await login(page);
  const wire = await enterRoom(page, 0, 'Activity checkpoint');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => wire.states.at(-1)).toBe('alive');
  const frames = [];
  wire.socket.on('framereceived', ({ payload }) => frames.push(parseDelivery(payload)));
  // A second tab for the same account replaces the first session. Use a distinct guest.
  const guest = await browser.newContext();
  const newcomer = await guest.newPage();
  try {
    await newcomer.goto(page.url());
    const arrival = () =>
      frames
        .flatMap((frame) => (frame.kind === 'events' ? frame.body.events : []))
        .find(
          (event) =>
            event.kind === 'activity' &&
            event.activity.kind === 'connected' &&
            event.activity.actor.id !== wire.id,
        )?.activity;
    await expect.poll(() => arrival()).toBeTruthy();
    const activity = arrival();
    const row = page
      .locator('#activity-feed li')
      .filter({ hasText: `${activity.actor.nickname} connected` });
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    const beforePause = frames.length;
    await page.evaluate(() => {
      const end = performance.now() + 1000;
      while (performance.now() < end) {
        /* Exercise the actual recovery barrier. */
      }
    });
    const recovered = () =>
      frames
        .slice(beforePause)
        .find((frame) => frame.kind === 'installation' && frame.body.type === 'resync');
    await expect.poll(() => recovered()).toBeTruthy();
    expect(recovered().body.activities.some((event) => event.id === activity.id)).toBe(true);
    expect(recovered().body.state).not.toHaveProperty('activities');
    await expect(page.locator('#online-menu')).toBeHidden();
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    for (const frame of frames.filter((frame) => frame.kind === 'state')) {
      expect(frame.body).not.toHaveProperty('activities');
    }
    await page.screenshot({ path: 'output/playwright/activity-checkpoint.png' });
  } finally {
    await guest.close();
    await page.goto('/manage/servers');
    await page
      .locator('#owned-servers .account-card')
      .filter({ has: page.getByRole('heading', { name: 'Local A', exact: true }) })
      .getByRole('link', { name: 'Manage rooms and access' })
      .click();
    const room = page.getByRole('row').filter({ hasText: 'Activity checkpoint' });
    await room.getByRole('button', { name: 'Close room', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Reason', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(room).toHaveCount(0);
  }
});

for (const joinDuringPause of [false, true])
  test(`one-second browser pause recovers the same socket ${joinDuringPause ? 'with a pending Play action' : 'with an acknowledged installation'}`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await login(page);
    const wire = await enterRoom(
      page,
      0,
      `Congestion recovery ${joinDuringPause ? 'pending' : 'ack'}`,
    );
    await enableDiagnostics(page);
    const frames = [];
    const receipts = [];
    let closed = false;
    wire.socket.on('close', () => {
      closed = true;
    });
    wire.socket.on('framereceived', ({ payload }) => frames.push(parseDelivery(payload)));
    wire.socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'receipt') receipts.push(message.receipt);
    });
    if (!joinDuringPause) {
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => wire.states.at(-1)).toBe('alive');
    }
    await page.evaluate((joinDuringPause) => {
      const end = performance.now() + 1000;
      while (performance.now() < end) {
        /* Model a stalled browser application. */
      }
      if (joinDuringPause) document.querySelector('#join').click();
    }, joinDuringPause);
    await expect
      .poll(() =>
        frames.some((frame) => frame.kind === 'installation' && frame.body.type === 'resync'),
      )
      .toBe(true);
    const recovery = frames.find(
      (frame) => frame.kind === 'installation' && frame.body.type === 'resync',
    );
    await expect
      .poll(() =>
        receipts.some(
          (receipt) =>
            receipt.generation === recovery.generation && receipt.sequence >= recovery.sequence,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        frames.some(
          (frame) =>
            frame.kind === 'state' &&
            frame.generation === recovery.generation &&
            frame.body.tick > recovery.body.tick,
        ),
      )
      .toBe(true);
    await expect.poll(() => wire.states.at(-1)).toBe('alive');
    await expect(page.locator('#online-menu')).toBeHidden();
    expect(closed).toBe(false);
    expect(new Set(frames.map((frame) => frame.connection)).size).toBe(1);
    const downloaded = page.waitForEvent('download');
    await page.keyboard.press('F8');
    const report = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
    expect(report.format).toBe('baboreborn-match-diagnostics-v1');
    const installations = report.timeline.samples.filter(
      (sample) => sample.kind === 'installation',
    );
    expect(
      report.timeline.samples.some((sample) => sample.kind === 'collection' && sample.data.enabled),
    ).toBe(true);
    expect(installations.some((sample) => sample.data.type === 'resync')).toBe(true);
    expect(
      report.timeline.samples.some(
        (sample) => sample.kind === 'snapshot' && sample.data.generation < recovery.generation,
      ),
    ).toBe(true);
    expect(
      report.timeline.samples.some(
        (sample) => sample.kind === 'snapshot' && sample.data.generation === recovery.generation,
      ),
    ).toBe(true);
    expect(report.webSocketExtensions).toContain('permessage-deflate');
    expect(report.payloadBytesIn).toBeGreaterThanOrEqual(
      Buffer.byteLength(JSON.stringify(recovery)),
    );
    expect(report.payloadBytesOut).toBeGreaterThan(0);
  });

test('nickname colors persist, preserve edited letters and reach other players', async ({
  page,
  browser,
  viewport,
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/character');
  const simple = page.getByLabel('Nickname', { exact: true });
  await simple.fill('DarkPaolo');
  await simple.press('Tab');
  await expect(page.getByLabel('Nickname preview')).toHaveCount(0);
  const advanced = page.getByRole('button', { name: 'Advanced…', exact: true });
  await advanced.click();
  const dialog = page.getByRole('dialog', { name: 'Edit nickname' });
  const input = dialog.getByLabel('Nickname', { exact: true });
  const preview = dialog.getByLabel('Nickname preview');
  await expect(dialog.getByRole('button', { name: 'Red', exact: true })).toHaveCSS(
    'background-color',
    'rgb(255, 51, 68)',
  );
  await expect(dialog.getByRole('button', { name: 'Cyan', exact: true })).toHaveCSS(
    'background-color',
    'rgb(85, 221, 255)',
  );
  await expect(input).toHaveCSS('font-size', '28px');
  await expect(preview).toHaveCSS('font-size', '36px');
  const palette = dialog.getByRole('group', { name: 'Nickname colors', exact: true });
  await expect(palette.getByRole('button')).toHaveCount(15);
  const paletteRows = () =>
    palette
      .locator(':scope > *')
      .evaluateAll(
        (elements) =>
          new Set(elements.map((el) => Math.round(el.getBoundingClientRect().top))).size,
      );
  expect(await paletteRows()).toBe(2);
  await input.focus();
  await input.evaluate((el) => {
    el.setSelectionRange(0, 0);
    el.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await dialog.getByLabel('Custom color', { exact: true }).fill('#12abef');
  await expect(preview.getByText('DarkPaolo', { exact: true })).toHaveCSS(
    'color',
    'rgb(18, 171, 239)',
  );
  await input.fill('Discarded');
  await dialog.getByRole('button', { name: 'Red', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(simple).toHaveValue('DarkPaolo');
  await expect(advanced).toBeFocused();
  await advanced.click();
  await input.fill(' DarkPaolo ');
  await input.focus();
  await input.evaluate((el) => {
    el.setSelectionRange(0, 0);
    el.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await dialog.getByRole('button', { name: 'Red', exact: true }).click();
  await input.focus();
  await input.evaluate((el) => {
    el.setSelectionRange(5, 10);
    el.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await dialog.getByRole('button', { name: 'Cyan', exact: true }).click();
  await expect(preview.getByText('Dark', { exact: true })).toHaveCSS('color', 'rgb(255, 51, 68)');
  await expect(preview.getByText('Paolo', { exact: true })).toHaveCSS('color', 'rgb(85, 221, 255)');
  await page.screenshot({ path: 'output/playwright/nickname-desktop.png' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await advanced.click();
  await expect(preview.getByText('Paolo', { exact: true })).toHaveCSS('color', 'rgb(85, 221, 255)');
  await input.fill('DarkXPaolo');
  await expect(preview.getByText('X', { exact: true })).toBeVisible();
  await expect(preview.getByText('Paolo', { exact: true })).toHaveCSS('color', 'rgb(85, 221, 255)');
  await dialog.getByRole('button', { name: 'Reset colors', exact: true }).click();
  await expect(preview.locator('.nickname > span')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(simple).toHaveValue('DarkPaolo');
  await advanced.click();
  await expect(preview.getByText('Paolo', { exact: true })).toHaveCSS('color', 'rgb(85, 221, 255)');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await paletteRows()).toBe(2);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/nickname-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  // Desktop/mobile layout checks are done; restore the shared gameplay viewport.
  await page.setViewportSize(viewport);
  const expected = 'ff3344'.repeat(4) + '55ddff'.repeat(5);
  const wire = await enterRoom(page, 0, 'Nickname colors');
  await expect
    .poll(() => wire.latest?.players.find((p) => p.id === wire.id)?.nicknameColors)
    .toBe(expected);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => wire.states.includes('alive')).toBe(true);
  const guest = await browser.newContext();
  try {
    const observer = await guest.newPage();
    const received = [];
    observer.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (url.pathname !== '/ws' || url.searchParams.get('info') === '1') return;
      socket.on('framereceived', ({ payload }) => {
        const frame = parseDelivery(payload);
        received.push(...(frame.body.state?.players ?? frame.body.players ?? []));
      });
    });
    await observer.goto(page.url());
    await expect
      .poll(() => received.some((p) => p.nickname === 'DarkPaolo' && p.nicknameColors === expected))
      .toBe(true);
    await observer.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(observer.locator('#online-menu')).toBeHidden();
    await observer.bringToFront();
    await observer.locator('#game').focus();
    await observer.keyboard.down('Tab');
    await expect(observer.locator('#standings')).toBeVisible();
    const ranking = observer.locator('#standings .nickname').filter({ hasText: 'DarkPaolo' });
    await expect(ranking.getByText('Dark', { exact: true })).toHaveCSS('color', 'rgb(255, 51, 68)');
    await expect(ranking.getByText('Paolo', { exact: true })).toHaveCSS(
      'color',
      'rgb(85, 221, 255)',
    );
    await observer.screenshot({ path: 'output/playwright/nickname-scoreboard.png' });
    await observer.keyboard.up('Tab');
  } finally {
    await guest.close();
  }
});

test('coverage audio decodes, follows live gameplay and releases loops on mute', async ({
  page,
}) => {
  test.setTimeout(120000);
  await login(page);
  await page.addInitScript(() => {
    const urls = new WeakMap();
    const names = new WeakMap();
    const loops = new Set();
    window.audioCoverage = { decoded: [], started: [], activeLoops: 0, maxLoops: 0 };
    const arrayBuffer = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async function () {
      const value = await arrayBuffer.call(this);
      urls.set(value, this.url);
      return value;
    };
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = async function (bytes) {
      const buffer = await decode.call(this, bytes);
      names.set(buffer, urls.get(bytes));
      window.audioCoverage.decoded.push(urls.get(bytes));
      return buffer;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.audioCoverage.started.push(names.get(this.buffer));
      if (this.loop) {
        loops.add(this);
        window.audioCoverage.activeLoops = loops.size;
        window.audioCoverage.maxLoops = Math.max(loops.size, window.audioCoverage.maxLoops);
        this.addEventListener('ended', () => {
          loops.delete(this);
          window.audioCoverage.activeLoops = loops.size;
        });
      }
      return start.apply(this, args);
    };
  });
  await enterRoom(page, 0, 'Audio coverage');
  await page.locator('#secondary').click();
  await page.getByRole('radio', { name: 'Instant Shield', exact: true }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const coverageFiles = [...new Set(Object.keys(AUDIO_SAMPLES).flatMap(sampleFiles))]
    .filter((file) => file.startsWith('coverage/'))
    .sort();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.audioCoverage.decoded
          .filter((url) => url?.includes('/coverage/'))
          .map((url) => new URL(url).pathname.slice('/audio/'.length))
          .sort(),
      ),
    )
    .toEqual(coverageFiles);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const sounded = (name) =>
    page.evaluate(
      (file) => window.audioCoverage.started.some((url) => url?.endsWith(`/coverage/${file}.wav`)),
      name,
    );
  await expect.poll(() => sounded('spawn')).toBe(true);
  await expect.poll(() => sounded('ambient-loop')).toBe(true);
  await page.keyboard.down('KeyW');
  await expect.poll(() => sounded('roll-loop')).toBe(true);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Space');
  await expect.poll(() => sounded('shield-end')).toBe(true);
  await page.mouse.click(400, 250, { button: 'middle' });
  await expect.poll(() => sounded('fire-loop')).toBe(true);
  await expect.poll(() => sounded('fire-end'), { timeout: 20000 }).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Combat sounds', exact: true }).uncheck();
  await expect.poll(() => page.evaluate(() => window.audioCoverage.activeLoops)).toBe(0);
  expect(await page.evaluate(() => window.audioCoverage.maxLoops)).toBeLessThanOrEqual(8);
});
