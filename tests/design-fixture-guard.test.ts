import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
import {
  assertDesignFixtureEnvironmentSync,
  validateDesignFixtureEnvironment,
} from '../apps/web/e2e/utils/design-fixture-guard'

const fixture = (): NodeJS.ProcessEnv => ({
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'venturi-systems/quackback',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  DESIGN_FIXTURE_POSTGRES_ID: 'a'.repeat(64),
  DESIGN_FIXTURE_REDIS_ID: 'b'.repeat(64),
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/quackback_test',
  REDIS_URL: 'redis://localhost:6379',
  BASE_URL: 'http://localhost:3000',
  TRUSTED_ORIGINS: 'http://acme.localhost:3000',
  SECRET_KEY: 'test-secret-for-ci-only-must-be-at-least-32-characters',
  BETTER_AUTH_SECRET: 'test-secret-for-ci-only-must-be-at-least-32-characters',
  VENTURI_TEAM_EMAIL_DOMAINS: 'example.com',
})

const fixtureServices = () => [
  {
    Id: 'a'.repeat(64),
    State: { Running: true },
    HostConfig: { NetworkMode: 'job-network' },
    Mounts: [] as Array<{ Type: string }>,
    NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '5432' }] } },
  },
  {
    Id: 'b'.repeat(64),
    State: { Running: true },
    HostConfig: { NetworkMode: 'job-network' },
    Mounts: [] as Array<{ Type: string }>,
    NetworkSettings: { Ports: { '6379/tcp': [{ HostPort: '6379' }] } },
  },
]

describe('design fixture isolation before setup', () => {
  it('accepts only the declared disposable fixture environment', () => {
    expect(() => validateDesignFixtureEnvironment(fixture())).not.toThrow()
  })

  it.each([
    ['CI', undefined],
    ['GITHUB_ACTIONS', undefined],
    ['GITHUB_REPOSITORY', 'acme/other'],
    ['GITHUB_RUN_ID', ''],
    ['GITHUB_RUN_ATTEMPT', ''],
    ['DESIGN_FIXTURE_POSTGRES_ID', undefined],
    ['DESIGN_FIXTURE_REDIS_ID', 'a'.repeat(64)],
    ['NODE_ENV', 'production'],
    ['DATABASE_URL', 'postgresql://postgres:password@feedback.venturi.systems:5432/quackback_test'],
    ['DATABASE_URL', 'postgresql://postgres:password@localhost:5433/quackback_test'],
    ['DATABASE_URL', 'postgresql://postgres:password@localhost:5432/production'],
    ['DATABASE_URL', 'postgresql://postgres:password@localhost:5432/quackback_test?host=remote'],
    ['DATABASE_URL', 'postgresql://postgres:unexpected-value@localhost:5432/quackback_test'],
    ['REDIS_URL', 'redis://localhost:6379/1'],
    ['BASE_URL', 'https://feedback.venturi.systems'],
    ['TRUSTED_ORIGINS', 'http://acme.localhost:3000,https://feedback.venturi.systems'],
    ['SECRET_KEY', 'unexpected-value'],
    ['BETTER_AUTH_SECRET', 'unexpected-value'],
    ['VENTURI_TEAM_EMAIL_DOMAINS', 'acme.example'],
    ['HTTP_PROXY', 'http://proxy.example'],
    ['AWS_ACCESS_KEY_ID', 'unexpected-value'],
    ['RESEND_API_KEY', 'unexpected-value'],
  ])('rejects unsafe effective %s without disclosing it', (key, value) => {
    const env = fixture()
    env[key!] = value
    expect(() => validateDesignFixtureEnvironment(env)).toThrow(
      'Design acceptance requires the isolated GitHub CI fixture'
    )
    try {
      validateDesignFixtureEnvironment(env)
    } catch (error) {
      expect(String(error)).not.toContain('unexpected-value')
    }
  })

  it.each([
    'https://feedback.venturi.systems',
    'http://acme.localhost:3000/admin',
    'http://user:password@acme.localhost:3000',
    'http://acme.localhost:3000/?target=other',
  ])('rejects a different browser target: %s', (target) => {
    expect(() => validateDesignFixtureEnvironment(fixture(), target)).toThrow()
  })
})

describe('design preflight side-effect boundary', () => {
  it('rejects missing CI context before launching a subprocess', () => {
    const saved = process.env.CI
    process.env.CI = ''
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow()
      expect(execFileSync).not.toHaveBeenCalled()
    } finally {
      if (saved === undefined) delete process.env.CI
      else process.env.CI = saved
    }
  })

  it.each(['shared-bind-mount', 'host-network', 'wrong-port', 'wrong-service-id', 'stopped'])(
    'rejects %s before any environment loader or fixture can start',
    (fault) => {
      const original = process.env
      process.env = fixture()
      const services = fixtureServices()
      if (fault === 'shared-bind-mount') services[0].Mounts.push({ Type: 'bind' })
      if (fault === 'host-network') services[0].HostConfig.NetworkMode = 'host'
      if (fault === 'wrong-port')
        services[0].NetworkSettings.Ports['5432/tcp']![0].HostPort = '6432'
      if (fault === 'wrong-service-id') services[0].Id = 'c'.repeat(64)
      if (fault === 'stopped') services[0].State.Running = false
      vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify(services))
      try {
        expect(() => assertDesignFixtureEnvironmentSync()).toThrow()
        expect(execFileSync).toHaveBeenCalledTimes(1)
        expect(vi.mocked(execFileSync).mock.calls[0][0]).toBe('docker')
      } finally {
        process.env = original
      }
    }
  )
})

describe('safe loader failure diagnostics', () => {
  it.each(['helper-environment', 'app-environment', 'migration-environment'])(
    'identifies %s without retaining private child output',
    (stage) => {
      const original = process.env
      process.env = fixture()
      const mock = vi.mocked(execFileSync)
      const index = ['helper-environment', 'app-environment', 'migration-environment'].indexOf(
        stage
      )
      mock.mockReturnValueOnce(JSON.stringify(fixtureServices()))
      for (let previous = 0; previous < index; previous += 1) {
        mock.mockReturnValueOnce('DESIGN_FIXTURE_ENVIRONMENT_OK')
      }
      mock.mockImplementationOnce(() => {
        throw Object.assign(new Error('private-child-payload'), {
          code: 'ENOENT',
          status: null,
          stderr: 'private-child-payload',
          env: { PRIVATE_TEST_VALUE: 'private-child-payload' },
        })
      })
      try {
        let captured: unknown
        try {
          assertDesignFixtureEnvironmentSync()
        } catch (error) {
          captured = error
        }
        expect(captured).toBeInstanceOf(Error)
        const failure = captured as Error
        expect(failure.message).toContain(stage)
        expect(failure.cause).toBeInstanceOf(Error)
        expect((failure.cause as Error).message).toBe('ENOENT; status=unknown')
        expect((failure.cause as Error).cause).toBeUndefined()
        expect(JSON.stringify(failure)).not.toContain('private-child-payload')
        expect(String(failure)).not.toContain('private-child-payload')
        expect(mock).toHaveBeenCalledTimes(index + 2)
      } finally {
        process.env = original
      }
    }
  )
})
