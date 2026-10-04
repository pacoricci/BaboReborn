import { test, expect } from '@playwright/test';
import { portal } from './playwright.config.mjs';

async function login(page, name) {
  await page.goto('/auth/login?return=/account');
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  return page.locator('#account-id').textContent();
}

test('account deletion confirms identity, revokes every session and broadcasts sign-out', async ({
  page,
  context,
  browser,
}) => {
  const account = await login(page, 'Deletion');
  const otherContext = await browser.newContext({ baseURL: portal });
  try {
    const otherDevice = await otherContext.newPage();
    expect(await login(otherDevice, 'Deletion')).toBe(account);
    const observer = await context.newPage();
    await observer.goto('/account');
    await observer.evaluate(() => {
      const channel = new BroadcastChannel('baboreborn.account');
      channel.onmessage = (event) => {
        document.body.dataset.accountEvent = event.data;
        channel.close();
      };
      localStorage.setItem('account-deletion-test', 'preserved');
    });
    await page.getByText('Delete account', { exact: true }).click();
    const form = page.locator('form[action="/auth/delete-account"]');
    await form.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: 'output/playwright/account-deletion-mobile.png',
      fullPage: true,
    });
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Portal account deleted.');
    await expect(observer.locator('body')).toHaveAttribute('data-account-event', 'signed-out');
    expect(await observer.evaluate(() => localStorage.getItem('account-deletion-test'))).toBe(
      'preserved',
    );
    expect((await otherContext.request.get('/api/v1/account')).ok()).toBe(true);
    const state = await (await otherContext.request.get('/api/v1/account')).json();
    expect(state.account).toBe('');
    expect(state.expired).toBe(true);
    expect((await page.request.get(`/identity/v1/accounts/${account}`)).status()).toBe(404);
    const recreated = await login(page, 'Deletion');
    expect(recreated).not.toBe(account);
  } finally {
    await otherContext.close();
  }
});

test('owners must resolve server ownership before account deletion', async ({ page }) => {
  const account = await login(page, 'Owner');
  await page.getByText('Delete account', { exact: true }).click();
  const form = page.locator('form[action="/auth/delete-account"]');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Transfer or remove your servers');
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/v1/account')).json()).account).toBe(account);
  await page.getByRole('alert').getByRole('link', { name: 'Manage servers' }).click();
  await expect(page).toHaveURL(/\/manage\/servers$/);
});
