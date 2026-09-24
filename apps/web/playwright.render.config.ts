import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for the signed-in render lane (e2e/render/README.md).
 *
 * It reuses the end-to-end suite's own admin sign-in (e2e/global-setup.ts),
 * signs in the lane's other fixture identity, then walks every planned route
 * with the keyboard. The design suite checker runs after this, outside
 * Playwright (e2e/render/run-checker.ts).
 *
 * There is no webServer: the lane measures the production image built from
 * apps/web/Dockerfile, which the workflow starts before this runs. Locally,
 * serve the app first.
 */
const outDir = path.resolve(process.env.RENDER_OUT_DIR || 'test-results/render')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A keyboard finding is a property of the page, not a flake; a retry would
  // only hide an intermittent defect behind a pass.
  retries: 0,
  workers: process.env.CI ? 3 : undefined,
  reporter: [['list'], ['json', { outputFile: path.join(outDir, 'playwright-results.json') }]],
  outputDir: path.join(outDir, 'playwright-output'),
  use: {
    baseURL: 'http://acme.localhost:3000',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global-setup\.ts/,
    },
    {
      name: 'render-identities',
      testMatch: /render\/identities\.setup\.ts/,
      dependencies: ['setup'],
    },
    {
      name: 'render-keyboard',
      testMatch: /render\/keyboard-walk\.spec\.ts/,
      dependencies: ['render-identities'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 240 * 1000,
  globalTimeout: 30 * 60 * 1000,
  expect: {
    timeout: 5 * 1000,
  },
})
