import { test, expect } from '@playwright/test';

test('guests can reach shipped credits and notices without signing in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Credits', exact: true }).click();
  await expect(page).toHaveURL(/\/credits\.html$/);
  await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible();
  await expect(page.locator('#original + p')).toContainText('CC BY-SA 4.0');
  await expect(page.locator('#icons + p')).toContainText('CC BY 3.0');
  await expect(page.locator('main')).toContainText('Delapouite');
  await expect(page.locator('main')).toContainText('Lorc');
  await expect(page.locator('main')).toContainText('Copyright 2012 bitHeads inc.');

  // Check the embedded release, not just the source tree's attribution files.
  for (const href of await page
    .locator('main a[href^="/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')))) {
    const response = await page.request.get(href);
    expect(response.ok(), href).toBe(true);
    expect((await response.body()).length, href).toBeGreaterThan(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/credits-mobile.png', fullPage: true });
  await page.getByRole('link', { name: 'Back to rooms' }).click();
  await expect(page).toHaveURL(/\/$/);
});
