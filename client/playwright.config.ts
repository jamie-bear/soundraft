import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './test/browser', fullyParallel: false, workers: 1, timeout: 45_000,
  reporter: 'list',
  use: { baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:4173', trace: 'off', video: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node ../server/test/browser-server.js', url: 'http://127.0.0.1:4173/api/live', timeout: 120_000, reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
})
