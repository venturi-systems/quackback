import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config'

// An explicit integration command must fail when prerequisites are absent.
// Ordinary unit runs keep their existing credential-free integration skips.
if (!process.env.API_KEY || process.env.SKIP_INTEGRATION === 'true') {
  throw new Error(
    'test:api requires API_KEY and a running API server; SKIP_INTEGRATION must not be true.'
  )
}

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['apps/web/src/lib/server/domains/api/__tests__/*-integration*.test.ts'],
    exclude: baseConfig.test?.exclude?.filter((pattern) => pattern !== '**/*-integration.test.ts'),
    // The suites create and clean up API resources on one target.
    fileParallelism: false,
  },
})
