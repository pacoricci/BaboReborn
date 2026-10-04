import { parseDelivery } from '../../frontend/src/network/protocol.ts';
import { test, expect } from '@playwright/test';
import { portal } from './playwright.config.mjs';

async function login(page) {
  await page.goto('/auth/login?return=/manage/servers');
  await page.getByRole('link', { name: 'Owner', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Manage servers', exact: true })).toBeVisible();
}

const server = (page) =>
  page
    .locator('.server-row')
    .filter({ has: page.getByRole('heading', { name: 'Local A', exact: true }) });

test('server settings preserve blurred drafts during polling and registration keeps actionable feedback', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const releaseVersion = process.env.RELEASE_VERSION ?? 'dev';
  const stableRelease = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(releaseVersion);
  await expect
    .poll(async () => {
      const servers = await (await page.request.get('/api/v1/manage/servers')).json();
      return servers.find((item) => item.name === 'Local A')?.release;
    })
    .toMatchObject({
      installed: releaseVersion,
      recommended: releaseVersion,
      status: stableRelease ? 'current' : 'compatible',
    });
  await server(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Region', { exact: true }).fill('Draft Europe');
  await dialog.getByRole('heading').click();
  await page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/manage/servers') &&
      response.request().method() === 'GET' &&
      response.ok(),
  );
  await expect(dialog.getByLabel('Region', { exact: true })).toHaveValue('Draft Europe');
  page.once('dialog', (prompt) => prompt.accept());
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(server(page).getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Register a server', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Management browser pending');
  await dialog.getByLabel('Region', { exact: true }).fill('Europe');
  await dialog.getByLabel('Public address', { exact: true }).fill('ftp://invalid.example.org');
  await dialog.getByRole('button', { name: 'Register a server', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Check the name');
  await dialog.getByLabel('Public address', { exact: true }).fill('https://ux-browser.example.org');
  const registration = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/manage/servers') &&
      response.request().method() === 'POST' &&
      response.ok(),
  );
  await dialog.getByRole('button', { name: 'Register a server', exact: true }).click();
  const { expiresAt } = await (await registration).json();
  expect(expiresAt).toMatch(/Z$/);
  const expiryLabel = await page.evaluate(
    (value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    expiresAt,
  );
  await expect(dialog.getByRole('heading')).toHaveText('Connect Management browser pending');
  await expect(dialog.locator('.pairing-code')).not.toBeEmpty();
  await expect(dialog.getByText(/It expires at/)).toContainText(`It expires at ${expiryLabel}.`);
  await expect(dialog.getByRole('button', { name: 'Download code file' })).toBeVisible();
  await expect(dialog.getByText('Check the name', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: 'output/playwright/management-pairing.png' });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const pending = page.locator('.server-row').filter({ hasText: 'Management browser pending' });
  await pending.getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog.getByText('Installation & ownership', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove registration', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove registration', exact: true }).click();
  await expect(pending).toHaveCount(0);
});

test('desktop room editor keeps drafts, renames a live match and limits pending work to its room', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await server(page).getByRole('link', { name: 'Manage rooms and access' }).click();
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name', { exact: true }).fill('UX live room');
  await expect(editor.getByLabel('Reason', { exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save room', exact: true }).click();
  await expect(editor).toBeHidden();
  const guestContext = await browser.newContext({ baseURL: portal });
  const game = await guestContext.newPage();
  const messages = [];
  game.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.pathname === '/ws' && url.searchParams.get('info') !== '1')
      socket.on('framereceived', ({ payload }) => messages.push(parseDelivery(payload).body));
  });
  await game.goto('/');
  await game
    .locator('.global-rooms tbody tr')
    .filter({ hasText: 'UX live room' })
    .getByRole('button', { name: 'Enter room' })
    .click();
  await game.getByRole('button', { name: 'Play', exact: true }).click();
  const alive = () =>
    messages
      .filter((message) => message.type === 'snapshot')
      .at(-1)
      ?.players.some((player) => player.status === 'alive');
  await expect.poll(alive).toBe(true);
  const row = page.locator('#managed-rooms tbody tr').filter({ hasText: 'UX live room' });
  await row.getByRole('button', { name: 'Configure', exact: true }).focus();
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/admin/rooms') && response.ok(),
  );
  await expect(row.getByRole('button', { name: 'Configure', exact: true })).toBeFocused();
  await row.getByRole('button', { name: 'Configure', exact: true }).click();
  await editor.getByLabel('Name', { exact: true }).fill('UX renamed room');
  await editor.getByRole('heading', { level: 2 }).click();
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/admin/rooms') && response.ok(),
  );
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('UX renamed room');
  const welcomes = messages.filter((message) => message.type === 'welcome').length;
  await editor.getByRole('button', { name: 'Save room', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Match continues' })).toBeVisible();
  await expect.poll(alive).toBe(true);
  expect(messages.filter((message) => message.type === 'welcome')).toHaveLength(welcomes);
  expect(messages.filter((message) => message.type === 'administration')).toHaveLength(0);
  const renamed = page.locator('#managed-rooms tbody tr').filter({ hasText: 'UX renamed room' });
  await renamed.getByRole('button', { name: 'Configure', exact: true }).click();
  await editor.getByLabel('Bots', { exact: true }).fill('1');
  await expect(editor.getByLabel('Reason', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'output/playwright/management-room-editor.png' });
  await editor.getByRole('button', { name: 'Review restart', exact: true }).click();
  await expect(editor.getByText(/10-second warning/)).toBeVisible();
  await editor.getByRole('button', { name: 'Restart room', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(renamed.getByRole('button', { name: 'Configure', exact: true })).toBeDisabled();
  await expect(page.locator('#management-title')).toBeFocused();
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(renamed.getByRole('button', { name: 'Configure', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await expect(game.locator('#online-menu')).toHaveAttribute('data-state', 'Spectating');
  const matchURL = game.url();
  await page.screenshot({ path: 'output/playwright/management-rooms-desktop.png' });
  await page.getByRole('button', { name: 'Players & moderation', exact: true }).click();
  await page.getByRole('button', { name: 'Moderate', exact: true }).focus();
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/admin/participants') && response.ok(),
  );
  await expect(page.getByRole('button', { name: 'Moderate', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Moderate', exact: true }).click();
  await expect(editor.getByLabel(/Reason/)).toHaveCount(0);
  await editor.getByRole('combobox', { name: 'Action', exact: true }).selectOption('0');
  await expect(editor.getByLabel('Reason (optional)', { exact: true })).not.toHaveAttribute(
    'required',
  );
  await editor.getByRole('button', { name: 'Review action', exact: true }).click();
  const ban = page.getByRole('dialog', { name: 'Ban player permanently', exact: true });
  await expect(ban.getByText(/until the restriction is revoked/)).toBeVisible();
  await ban.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Restrictions', exact: true }).click();
  await expect(page.locator('.restriction-row')).toContainText('Permanent');
  await page
    .locator('.restriction-row')
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await expect(editor.getByLabel('Reason', { exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('No active restrictions.', { exact: true })).toBeVisible();
  await game.goto(matchURL);
  await expect(game.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Players & moderation', exact: true }).click();
  await page.getByRole('button', { name: 'Moderate', exact: true }).click();
  await editor.getByRole('combobox', { name: 'Action', exact: true }).selectOption('5');
  await editor.getByRole('button', { name: 'Review action', exact: true }).click();
  const temporaryBan = page.getByRole('dialog', { name: 'Restrict player', exact: true });
  await temporaryBan.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Restrictions', exact: true }).click();
  const restrictionsResponse = await page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/admin/sanctions') && response.ok(),
  );
  const restrictions = await restrictionsResponse.json();
  const temporary = restrictions.find((restriction) => restriction.expiresAt !== null);
  expect(temporary.createdAt).toMatch(/Z$/);
  expect(temporary.expiresAt).toMatch(/Z$/);
  expect(temporary.revokedAt).toBeNull();
  const expiryLabel = await page.evaluate(
    (expiry) => new Date(expiry).toLocaleString(),
    temporary.expiresAt,
  );
  await expect(page.locator('.restriction-row')).toContainText('Active');
  await expect(page.locator('.restriction-row')).toContainText(`Until ${expiryLabel}`);
  await game.goto(matchURL);
  await expect(game.getByText(`Access blocked · ${expiryLabel}`, { exact: true })).toBeVisible();
  await page
    .locator('.restriction-row')
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await editor.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('No active restrictions.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('history');
  await expect(page.locator('.restriction-row')).toHaveCount(2);
  await expect(page.locator('.restriction-row .state-badge')).toHaveText(['Revoked', 'Revoked']);
  await page.getByRole('button', { name: 'Activity history', exact: true }).click();
  await page.locator('.activity-row details summary').first().click();
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/admin/events') && response.ok(),
  );
  await expect(page.locator('.activity-row details').first()).toHaveAttribute('open', '');
  for (const date of await page.locator('.activity-row time').allTextContents()) {
    expect(date).not.toContain('Invalid Date');
  }
  await page.getByRole('button', { name: 'Rooms', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await renamed.getByRole('button', { name: 'Configure', exact: true }).click();
  const save = await editor.getByRole('button', { name: 'Save room', exact: true }).boundingBox();
  expect(save.y + save.height).toBeLessThan(844);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await guestContext.close();
  await renamed.getByRole('button', { name: 'Close room', exact: true }).click();
  await expect(editor.getByLabel('Reason', { exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(renamed).toHaveCount(0, { timeout: 20000 });
});

test('offline registry writes fail visibly and are never replayed on reconnect', async ({
  page,
  context,
}) => {
  await login(page);
  await server(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Region', { exact: true }).fill('Offline draft');
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().includes('/api/v1/manage/servers/')) writes++;
  });
  await context.setOffline(true);
  await dialog.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(dialog.locator('.feedback.error')).not.toBeEmpty();
  await expect(dialog.getByRole('button', { name: 'Save details', exact: true })).toBeEnabled();
  expect(writes).toBe(1);
  const refreshed = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/manage/servers') && response.ok(),
  );
  await context.setOffline(false);
  await refreshed;
  expect(writes).toBe(1);
  await expect(dialog.getByLabel('Region', { exact: true })).toHaveValue('Offline draft');
  page.once('dialog', (prompt) => prompt.accept());
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('server release advice shows optional and required updates with contract details', async ({
  page,
}) => {
  let status = 'update_available';
  await page.route('**/api/v1/manage/servers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const servers = await response.json();
    for (const item of servers) {
      if (item.name !== 'Local A') continue;
      item.online = status === 'update_available';
      item.compatible = status === 'update_available';
      item.error =
        status === 'unknown'
          ? 'https_unreachable'
          : status === 'update_available'
            ? ''
            : 'incompatible_server';
      item.release = {
        installed: '1.0.0',
        recommended: '2.0.0',
        status,
        checkedAt: '2026-10-04T10:00:00Z',
        differences:
          status === 'update_required'
            ? [
                { contract: 'protocol', expected: '2', received: '1' },
                { contract: 'profile', expected: 'a'.repeat(64), received: 'b'.repeat(64) },
              ]
            : [],
        notesUrl: 'https://github.com/pacoricci/BaboReborn/releases/tag/v2.0.0',
      };
    }
    await route.fulfill({ response, json: servers });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const row = server(page);
  await expect(row.locator('.state-badge')).toHaveText('Online · update available');
  await expect(row.getByRole('link', { name: 'Manage rooms and access' })).toBeVisible();
  await expect(row.getByText(/Installed: 1.0.0/)).toContainText('Recommended: 2.0.0');
  await expect(row.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
    'href',
    /v2\.0\.0$/,
  );
  status = 'update_required';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(row.locator('.state-badge')).toHaveText('Update required');
  await expect(row.getByRole('link', { name: 'Manage rooms and access' })).toBeHidden();
  await row.getByText('Compatibility details', { exact: true }).click();
  await expect(row.getByText('protocol: expected 2, received 1')).toBeVisible();
  await page.screenshot({ path: 'output/playwright/management-release-advice.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: 'output/playwright/management-release-advice-mobile.png' });
  status = 'unknown';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(row.getByText(/Awaiting verification/)).toBeVisible();
  await expect(row.getByRole('link', { name: 'Release notes' })).toBeHidden();
});
