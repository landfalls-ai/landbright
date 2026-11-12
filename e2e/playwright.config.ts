import { defineConfig, devices } from '@playwright/test';

/**
 * Real Chromium against the built stack (`test/stack.ts` with the console): the console's pages and the sign-in pages,
 * passkeys through Chrome's virtual authenticator. One story, in order, so one worker.
 * `LANDBRIGHT_SCREENSHOTS=1` also writes each screen to `docs/screenshots/`.
 */
export default defineConfig({
  testDir: 'browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },
});
