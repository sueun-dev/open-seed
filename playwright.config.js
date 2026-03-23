const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    viewport: { width: 800, height: 600 },
    actionTimeout: 5000,
  },
  webServer: {
    command: 'npx serve . -l 3000 --no-clipboard',
    port: 3000,
    timeout: 10000,
    reuseExistingServer: !process.env.CI,
  },
});
