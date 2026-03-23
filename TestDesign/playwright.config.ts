import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 15000,
  use: { baseURL: 'http://localhost:8080' },
  webServer: { command: 'npx http-server . -p 8080 -c-1', port: 8080, reuseExistingServer: true }
});