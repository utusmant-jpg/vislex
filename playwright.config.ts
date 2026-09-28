import { defineConfig } from '@playwright/test';

// PW_PORT lets parallel worktrees run their own preview server without colliding.
const port = Number(process.env.PW_PORT ?? 4174);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    // Windows dev machines use installed Edge; Linux/CI containers point PW_CHROMIUM_PATH at a bundled Chromium.
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : { channel: 'msedge' }),
    viewport: { width: 1500, height: 960 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
