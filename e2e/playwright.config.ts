import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Runs against the production build served by the real API, with a throwaway database.
const port = 3210;
const dataDir = (process.env['E2E_DATA_DIR'] ??= mkdtempSync(path.join(tmpdir(), 'studio-e2e-')));

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Uses the installed Google Chrome. Set E2E_CHANNEL=msedge to use Edge.
    channel: process.env['E2E_CHANNEL'] ?? 'chrome',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: 'node ../server/src/main.ts',
    url: `http://127.0.0.1:${port}/api/auth/me`,
    env: { PORT: String(port), DATA_DIR: dataDir },
    reuseExistingServer: false,
  },
});
