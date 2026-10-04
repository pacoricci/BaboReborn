import { defineConfig } from '@playwright/test';

export const offset = Number(process.env.BABOREBORN_BROWSER_PORT_OFFSET ?? 10000);
export const portal = `http://127.0.0.1:${18090 + offset}`;
export const contentOrigin = `http://localhost:${18090 + offset}`;
export const community = (index) => `http://127.0.0.1:${18080 + offset + index}`;

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
    // Keep two real WebGL scenes affordable on CPU-only CI runners.
    viewport: { width: 800, height: 600 },
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
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
