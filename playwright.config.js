// End-to-end tests: the real index.html in Chromium, with every
// external service (Open-Meteo, Overpass, Nominatim, map tiles, CDNs)
// replaced by local fixtures - see tests/e2e/site.js.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure'
  }
});
