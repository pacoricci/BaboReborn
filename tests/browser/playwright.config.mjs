import { defineConfig } from '@playwright/test';

export const offset = Number(process.env.BABOREBORN_BROWSER_PORT_OFFSET ?? 10000);
export const portal = `http://127.0.0.1:${18090 + offset}`;
export const contentOrigin = `http://localhost:${18090 + offset}`;
export const community = (index) => `http://127.0.0.1:${18080 + offset + index}`;
// Linux CI uses Mesa under Xvfb; SwiftShader stalls live session/audio delivery.
const softwareGL = process.env.BABOREBORN_SOFTWARE_GL === '1';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: '../../output/playwright/results',
  reporter: [['list'], ['html', { outputFolder: '../../output/playwright/report', open: 'never' }]],
  use: {
    baseURL: portal,
    browserName: 'chromium',
    channel: softwareGL ? 'chromium' : undefined,
    headless: !softwareGL,
    // Keep two real WebGL scenes affordable on CPU-only CI runners.
    viewport: { width: 800, height: 600 },
    storageState: softwareGL
      ? {
          cookies: [],
          origins: [
            {
              origin: portal,
              localStorage: [
                { name: 'baboreborn.player.global.v1', value: JSON.stringify({ quality: 'low' }) },
              ],
            },
          ],
        }
      : undefined,
    launchOptions: softwareGL
      ? {
          args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
          env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' },
        }
      : { args: ['--enable-unsafe-swiftshader'] },
    // Avoid continuous GPU readbacks on software renderers; failure screenshots remain.
    trace: { mode: 'retain-on-failure', screenshots: !softwareGL },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'sh tests/browser/stack.sh',
    cwd: '../..',
    url: `${portal}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
