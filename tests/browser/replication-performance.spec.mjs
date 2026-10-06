// Opt-in real WebGL measurement, separate from the server bandwidth experiment.
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

test('measure real browser frame time during a 16-participant battle', async ({ page }) => {
  test.skip(!process.env.REPLICATION_BROWSER_REPORT, 'opt-in performance run');
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.replicationFrames = [];
    window.requestAnimationFrame = (callback) =>
      request((now) => {
        const start = performance.now();
        callback(now);
        window.replicationFrames.push({ at: now, callbackMs: performance.now() - start });
      });
  });
  await page.goto('/auth/login?return=/account');
  await page.getByRole('link', { name: 'Owner', exact: true }).click();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  await page.goto('/manage/servers');
  const server = page.locator('#owned-servers .account-card').filter({
    has: page.getByRole('heading', { name: 'Local A', exact: true }),
  });
  await expect(server.getByRole('link', { name: 'Manage rooms and access' })).toBeVisible({
    timeout: 40000,
  });
  await server.getByRole('link', { name: 'Manage rooms and access' }).click();
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name', { exact: true }).fill('Replication performance');
  await editor.getByLabel('Bots', { exact: true }).fill('15');
  await editor.getByRole('button', { name: 'Save room' }).click();
  await expect(editor).not.toBeVisible();
  await page.goto('/rooms');
  await page
    .locator('.global-rooms tbody tr')
    .filter({ hasText: 'Replication performance' })
    .getByRole('button', { name: 'Enter room' })
    .click();
  await expect(page.locator('#join')).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Diagnostics' }).click();
  await page.getByRole('checkbox', { name: 'Collect diagnostics', exact: true }).check();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.waitForTimeout(5000);
  await page.evaluate(() => {
    window.replicationFrames = [];
  });
  await page.waitForTimeout(10000);
  const frames = await page.evaluate(() => window.replicationFrames);
  const downloaded = page.waitForEvent('download');
  await page.keyboard.press('F8');
  const diagnostics = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  expect(diagnostics.connected).toBe(true);
  expect(diagnostics.authority.players).toHaveLength(16);
  expect(errors).toEqual([]);
  expect(frames.length).toBeGreaterThan(100);
  await writeFile(
    process.env.REPLICATION_BROWSER_REPORT,
    JSON.stringify(
      {
        protocol: diagnostics.protocol,
        frames,
        diagnostics,
        errors,
        conditions: {
          warmupSeconds: 5,
          measuredSeconds: 10,
          bots: 15,
          clients: 1,
          viewport: { width: 800, height: 600 },
          renderer: 'Chromium WebGL / SwiftShader',
          input: 'stationary spectator, 15 authoritative bots',
        },
      },
      null,
      2,
    ) + '\n',
  );
});
