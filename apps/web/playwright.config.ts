import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for Quackback E2E tests
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Use 1 worker per shard in CI (sharding provides parallelism, 1 worker reduces flakiness) */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use - blob for CI (enables sharding/merging), html for local */
  reporter: process.env.CI
    ? [['blob', { outputDir: 'blob-report' }], ['list']]
    : [['html', { outputFolder: 'playwright-report' }], ['list']],

  /* Shared settings for all the projects below */
  use: {
    /* Base URL for tenant subdomain (acme workspace from seed data) */
    baseURL: 'http://acme.localhost:3000',

    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    /* Setup project - authenticates and saves state */
    {
      name: 'setup',
      testMatch: /global-setup\.ts/,
      teardown: 'cleanup',
    },
    {
      name: 'cleanup',
      testMatch: /global-teardown\.ts/,
    },

    /* Main test project using authenticated state (admin tests only) */
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /* Use larger viewport to ensure detail panels are visible */
        viewport: { width: 1920, height: 1080 },
        /* Use saved auth state */
        storageState: 'e2e/.auth/admin.json',
      },
      dependencies: ['setup'],
      /* Only run admin tests (authenticated) */
      testMatch: /tests\/admin\/.+\.spec\.ts/,
    },

    /* Auth tests need fresh session (no stored state) */
    {
      name: 'chromium-auth',
      use: {
        ...devices['Desktop Chrome'],
        /* No stored auth state - tests manage their own auth */
      },
      /* `setup` is a dependency even though these tests sign themselves in.
         Under --shard Playwright splits the test list, and a dependency is the
         only thing that pulls `setup` into a shard: a shard holding only
         chromium-auth / chromium-public tests would otherwise run none of it.
         Two concrete consequences when it does not run — both silent, both
         shard-dependent: unified-login.spec.ts reads e2e/.auth/admin.json,
         which only setup writes, and every loginViaMagicLink call needs the
         magic-link method setup turns on (db:seed leaves settings.auth_config
         NULL and magicLink is opt-in). */
      dependencies: ['setup'],
      testMatch: /tests\/auth\/.+\.spec\.ts/,
    },

    /* Tests that don't need authentication (public portal) */
    {
      name: 'chromium-public',
      use: {
        ...devices['Desktop Chrome'],
      },
      /* Same reason as chromium-auth. board-access-matrix.spec.ts signs several
         identities in through magic link, and voting/comments specs sign in
         through email-OTP — which the gate resolves to the SAME magicLink key
         (normalizeMethodKey maps 'email' to 'magicLink'), so without setup the
         send is answered `error=magic_link_method_not_allowed` and their
         beforeAll retry loop burns its 30s hook budget. Shard 4 of 4 is 195
         chromium-public tests and nothing else, so this is the whole shard. */
      dependencies: ['setup'],
      testMatch: /tests\/public\/.+\.spec\.ts/,
    },
  ],

  /* Run local dev server before starting the tests */
  webServer: {
    command: 'bun run dev',
    url: 'http://acme.localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },

  /* Timeout for each test */
  timeout: 30 * 1000,

  /* Timeout for each assertion */
  expect: {
    timeout: 5 * 1000,
  },
})
