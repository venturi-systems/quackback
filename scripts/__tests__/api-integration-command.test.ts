import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cli = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url))

function collect(apiKey: string, skip = 'false') {
  return spawnSync(
    process.execPath,
    [cli, 'list', '--config', 'vitest.api.config.ts', '--filesOnly'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, API_KEY: apiKey, SKIP_INTEGRATION: skip },
    }
  )
}

describe('API integration command', () => {
  it('collects the relocated API suites despite the unit-suite exclusions', () => {
    const result = collect('fixture-key-used-only-for-collection')
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n').sort()).toEqual([
      'apps/web/src/lib/server/domains/api/__tests__/api-integration-advanced.test.ts',
      'apps/web/src/lib/server/domains/api/__tests__/api-integration.test.ts',
      'apps/web/src/lib/server/domains/api/__tests__/webhooks-integration.test.ts',
    ])
  })

  it('fails when the requested integration run has no API key', () => {
    const result = collect('')
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('test:api requires API_KEY')
  })

  it('rejects a requested integration run that would skip every suite', () => {
    const result = collect('fixture-key-used-only-for-collection', 'true')
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('SKIP_INTEGRATION must not be true')
  })
})
