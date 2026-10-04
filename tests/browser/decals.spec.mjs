import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('editor decals survive history, file round trip and the playable WebGL trial', async ({
  page,
}) => {
  const errors = [];
  const loadedTextures = new Set();
  page.on('pageerror', (error) => errors.push(error.message));
  // Editor and WebGL reuse the same immutable image; observe before either can cache it.
  page.on('response', (response) => {
    if (response.ok()) loadedTextures.add(response.url());
  });
  await page.goto('/editor.html');
  await expect(page.locator('#validation-summary')).toHaveText('Ready to test');
  await page.getByRole('button', { name: 'Decal 5', exact: true }).click();
  await page.getByRole('button', { name: 'Worn hazard marking', exact: true }).click();
  const canvas = page.locator('#map');
  await canvas.focus();
  for (let i = 0; i < 3; i++) {
    await canvas.press('ArrowRight');
    await canvas.press('ArrowUp');
  }
  await canvas.press('Space');
  await expect(page.getByRole('group', { name: 'Selected decal' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Decal width', exact: true }).fill('3');
  await page.getByRole('spinbutton', { name: 'Decal width', exact: true }).press('Tab');
  await page.getByRole('spinbutton', { name: 'Decal rotation', exact: true }).fill('35');
  await page.getByRole('spinbutton', { name: 'Decal rotation', exact: true }).press('Tab');
  await expect(canvas).toBeInViewport();
  await page.getByRole('spinbutton', { name: 'Decal width', exact: true }).fill('99');
  await page.getByRole('spinbutton', { name: 'Decal width', exact: true }).press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'Decal width', exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('#summary')).toContainText('2 decals');
  await page.getByRole('button', { name: 'Remove decal', exact: true }).click();
  await expect(page.locator('#summary')).toContainText('1 decals');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#summary')).toContainText('2 decals');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('#summary')).toContainText('1 decals');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save map', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved.schema).toBe(1);
  expect(saved.decals).toHaveLength(1);
  expect(saved.decals[0]).toMatchObject({ asset: 'marking', x: 5.5, y: 5.5, w: 3, opacity: 0.6 });
  expect(saved.decals[0].angle).toBeCloseTo((35 * Math.PI) / 180);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.locator('#file').setInputFiles(path);
  await expect(page.locator('#notice')).toContainText('Opened');
  await expect(page.locator('#summary')).toContainText('1 decals');
  const catalog = await (await page.request.get('/content/v1/catalog')).json();
  const texture = catalog.decals.find((asset) => asset.id === 'marking').texture;
  await page.getByRole('button', { name: 'Test map', exact: true }).click();
  await expect(page.locator('#trial')).toBeVisible();
  expect(loadedTextures.has(new URL(texture, catalog.fileOrigin || page.url()).href)).toBe(true);
  await page.screenshot({ path: 'output/playwright/decal-trial.png' });
  await page.getByRole('button', { name: 'Back to builder' }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  expect(errors).toEqual([]);
});

test('catalog decal images decode with transparency and stay within content limits', async ({
  page,
}) => {
  await page.goto('/play.html');
  const assets = await page.evaluate(async () => {
    const catalog = await (await fetch('/content/v1/catalog')).json();
    const result = [];
    for (const decal of catalog.decals) {
      const response = await fetch(`${catalog.fileOrigin}${decal.texture}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let transparent = 0,
        opaque = 0;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] === 0) transparent++;
        if (pixels[i] > 0) opaque++;
      }
      result.push({
        id: decal.id,
        width: bitmap.width,
        height: bitmap.height,
        transparent,
        opaque,
      });
      bitmap.close();
    }
    return result;
  });
  expect(assets.map((asset) => asset.id).sort()).toEqual([
    'arrow',
    'crack',
    'marking',
    'oil',
    'rust',
    'scorch',
    'skid',
  ]);
  for (const asset of assets) {
    expect(asset.width).toBeLessThanOrEqual(1024);
    expect(asset.height).toBeLessThanOrEqual(1024);
    expect(asset.transparent).toBeGreaterThan(0);
    expect(asset.opaque).toBeGreaterThan(0);
  }
});
