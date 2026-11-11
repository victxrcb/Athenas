import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:1420', channel: 'msedge', viewport: { width: 1440, height: 900 } },
  webServer: { command: 'node node_modules/vite/bin/vite.js', url: 'http://127.0.0.1:1420', reuseExistingServer: true },
});
