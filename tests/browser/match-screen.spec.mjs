import { test, expect } from '@playwright/test';
import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

test('winner presentation survives clearing results at the next map installation', async ({
  page,
}) => {
  const bundle = await build({
    configFile: false,
    plugins: [solid()],
    logLevel: 'silent',
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL('./fixtures/match-screen.ts', import.meta.url)),
        formats: ['es'],
      },
    },
  });
  const script = bundle[0].output.find((entry) => entry.type === 'chunk').code;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/screen-regression', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="finish">Finish round</button><button id="advance">Advance round</button><div id="screen"></div><script type="module" src="/screen-regression.js"></script>',
    }),
  );
  await page.route('**/screen-regression.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: script }),
  );
  await page.goto('/screen-regression');
  for (let round = 0; round < 2; round++) {
    await page.getByRole('button', { name: 'Finish round', exact: true }).click();
    await expect(page.locator('#standings')).toBeVisible();
    await expect(page.locator('#result-summary')).toHaveText('Player 1 wins · 50 points');
    await page.getByRole('button', { name: 'Advance round', exact: true }).click();
    await expect(page.locator('#standings')).toBeHidden();
    await expect(page.locator('#title')).toHaveText('Match menu');
    expect(errors).toEqual([]);
  }
});
