import { defineConfig, devices } from '@playwright/test';

// Playwright e2e harness for GregSweeper. Serves the static app with the
// dependency-free node static server (no Python needed in CI) and drives it in
// headless Chromium — matching the app's existing headless-Chrome profile;
// cross-browser isn't this app's risk surface. Tests load with ?isTest=1 so
// isTestEnvironment() short-circuits every Firebase WRITE while leaving reads
// live, keeping journeys off the production leaderboard.

const PORT = 8123;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node scripts/serve-static.mjs ${PORT}`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
