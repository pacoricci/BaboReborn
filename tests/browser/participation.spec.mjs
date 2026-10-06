import { test, expect } from '@playwright/test';
import { parseDelivery } from '../../frontend/src/network/protocol.ts';

function observe(page) {
  const messages = [];
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.pathname === '/ws' && url.searchParams.get('info') !== '1') {
      socket.on('framereceived', ({ payload }) => messages.push(parseDelivery(payload).body));
    }
  });
  return messages;
}

test('a second account tab replaces the first and normal re-entry remains available', async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await page.goto('/auth/login?return=/manage/servers');
  await page.getByRole('link', { name: 'Owner', exact: true }).click();
  await page
    .locator('.server-row')
    .filter({ has: page.getByRole('heading', { name: 'Local A', exact: true }) })
    .getByRole('link', { name: 'Manage rooms and access' })
    .click();
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Name', { exact: true }).fill('Account re-entry');
  await editor.getByRole('button', { name: 'Save room', exact: true }).click();
  await expect(editor).toBeHidden();
  const managementURL = page.url();
  const first = await context.newPage();
  const firstMessages = observe(first);
  const second = await context.newPage();
  const secondMessages = observe(second);
  try {
    await first.goto('/rooms');
    await first
      .locator('.global-rooms tbody tr')
      .filter({ hasText: 'Account re-entry' })
      .getByRole('button', { name: 'Enter room' })
      .click();
    await expect(first.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Play', exact: true }).click();
    await expect
      .poll(() => firstMessages.find((message) => message.type === 'welcome')?.id)
      .toBeTruthy();
    const firstID = firstMessages.find((message) => message.type === 'welcome').id;
    const matchURL = first.url();
    await second.goto(matchURL);
    await expect(second.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(first.getByText('Game session opened elsewhere.', { exact: true })).toBeVisible();
    await expect
      .poll(() => secondMessages.find((message) => message.type === 'welcome')?.id)
      .toBeTruthy();
    const secondID = secondMessages.find((message) => message.type === 'welcome').id;
    expect(secondID).not.toBe(firstID);
    await second.getByRole('button', { name: 'Play', exact: true }).click();
    await expect
      .poll(() =>
        secondMessages
          .filter((message) => message.type === 'snapshot')
          .at(-1)
          ?.players.some((player) => player.id === secondID && player.status === 'alive'),
      )
      .toBe(true);
    await second.close();
    const count = firstMessages.filter((message) => message.type === 'welcome').length;
    await first.goto(matchURL);
    await expect(first.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect
      .poll(() => firstMessages.filter((message) => message.type === 'welcome').length)
      .toBe(count + 1);
    await first.screenshot({ path: 'output/playwright/participation-rejoined.png' });
  } finally {
    await first.close();
    if (!second.isClosed()) await second.close();
    await page.goto(managementURL);
    const room = page.locator('#managed-rooms tbody tr').filter({ hasText: 'Account re-entry' });
    await room.getByRole('button', { name: 'Close room', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(room).toHaveCount(0);
  }
});
