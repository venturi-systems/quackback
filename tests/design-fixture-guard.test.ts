import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
import {
  assertDesignFixtureEnvironmentSync,
  validateDesignFixtureEnvironment,
  designFixtureEnvironmentReceipt,
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
  VENTURI_TEAM_EMAIL_DOMAINS: 'example.com,acme.example',
})

const fixtureServices = () => [
  {
    Id: 'a'.repeat(64),
    State: { Running: true },
    HostConfig: { NetworkMode: 'job-network' },
    Mounts: [] as Array<{ Type: string }>,
    NetworkSettings: {
      Ports: { '5432/tcp': [{ HostPort: '5432' }] },
      Networks: { 'job-network': { NetworkID: 'f'.repeat(64) } } as Record<
        string,
        { NetworkID: string }
      >,
    },
  },
  {
    Id: 'b'.repeat(64),
    State: { Running: true },
    HostConfig: { NetworkMode: 'job-network' },
    Mounts: [] as Array<{ Type: string }>,
    NetworkSettings: {
      Ports: { '6379/tcp': [{ HostPort: '6379' }] },
      Networks: { 'job-network': { NetworkID: 'f'.repeat(64) } } as Record<
        string,
        { NetworkID: string }
      >,
    },
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
    ['HTTP_PROXY', 'http://proxy.example'],
    ['AWS_ACCESS_KEY_ID', 'unexpected-value'],
    ['DOCKER_HOST', 'tcp://other-daemon.acme.example:2375'],
    ['DOCKER_CONTEXT', 'different-daemon'],
    ['DOCKER_TLS', 'true'],
    ['DOCKER_TLS_VERIFY', '1'],
    ['DOCKER_CERT_PATH', '/different-daemon-certs'],
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
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['legacy-only', 'example.com'],
    ['design-only', 'acme.example'],
    ['additional', 'example.com,acme.example,other.example'],
    ['subdomain', 'example.com,sub.acme.example'],
    ['look-alike', 'example.com,acme.example.attacker.example'],
  ] as const)('rejects %s team domains before launching any subprocess', (_case, domains) => {
    const original = process.env
    const env = fixture()
    if (domains === undefined) delete env.VENTURI_TEAM_EMAIL_DOMAINS
    else env.VENTURI_TEAM_EMAIL_DOMAINS = domains
    process.env = env
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow(
        'Design acceptance requires the isolated GitHub CI fixture'
      )
      expect(execFileSync).not.toHaveBeenCalled()
    } finally {
      process.env = original
    }
  })

  it.each(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])(
    'rejects inherited %s before any Docker inspection',
    (name) => {
      const original = process.env
      process.env = { ...fixture(), [name]: 'different-daemon' }
      try {
        expect(() => assertDesignFixtureEnvironmentSync()).toThrow()
        expect(execFileSync).not.toHaveBeenCalled()
      } finally {
        process.env = original
      }
    }
  )

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
        mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(process.env))
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

describe('email transport isolation', () => {
  it.each([
    'EMAIL_SMTP_HOST',
    'EMAIL_SMTP_PORT',
    'EMAIL_SMTP_SECURE',
    'EMAIL_SMTP_USER',
    'EMAIL_SMTP_PASS',
    'EMAIL_RESEND_API_KEY',
    'EMAIL_FROM',
    'EMAIL_UNRECOGNIZED_PROVIDER',
    'RESEND_API_KEY',
  ])('rejects inherited %s before inspecting services or loading fixtures', (name) => {
    const original = process.env
    process.env = { ...fixture(), [name]: 'unexpected-value' }
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow(
        'Design acceptance requires the isolated GitHub CI fixture'
      )
      expect(execFileSync).not.toHaveBeenCalled()
    } finally {
      process.env = original
    }
  })

  const capture = (): NodeJS.ProcessEnv => ({
    ...fixture(),
    DESIGN_FIXTURE_MAILPIT_ID: 'c'.repeat(64),
    DESIGN_FIXTURE_MAILPIT_NETWORK: 'job-network',
    // Deliberately fictional digest: only a pure guard fixture, never a service declaration.
    DESIGN_FIXTURE_MAILPIT_IMAGE: 'axllent/mailpit@sha256:' + 'd'.repeat(64),
    EMAIL_SMTP_HOST: '127.0.0.1',
    EMAIL_SMTP_PORT: '1025',
    EMAIL_SMTP_SECURE: 'false',
    EMAIL_FROM: 'Avery Stone <avery.stone@acme.example>',
  })

  const mailpit = () => ({
    Id: 'c'.repeat(64),
    Image: ('sha256:' + 'e'.repeat(64)) as string | undefined,
    State: { Running: true, Health: { Status: 'healthy' } },
    HostConfig: {
      NetworkMode: 'job-network',
      PortBindings: {
        '1025/tcp': [{ HostIp: '127.0.0.1', HostPort: '1025' }],
      } as Record<string, Array<{ HostIp: string; HostPort: string }> | null> | undefined,
    },
    Mounts: [] as Array<{ Type: string }>,
    NetworkSettings: {
      Networks: { 'job-network': { NetworkID: 'f'.repeat(64) } } as Record<
        string,
        { NetworkID: string }
      >,
      Ports: {
        '1025/tcp': [{ HostIp: '127.0.0.1', HostPort: '1025' }],
        '8025/tcp': null,
        '1110/tcp': null,
      } as Record<string, Array<{ HostIp: string; HostPort: string }> | null>,
    },
    Config: {
      Image: 'axllent/mailpit@sha256:' + 'd'.repeat(64),
      Entrypoint: ['/mailpit'],
      Cmd: [] as string[],
      Env: ['PATH=/usr/local/bin:/usr/bin:/bin'],
      Healthcheck: { Test: ['CMD', '/mailpit', 'readyz'] } as { Test?: string[] } | undefined,
    },
  })

  // Config ID deliberately differs from the index pin: they identify different objects.
  const mailpitImage = () => ({
    Id: 'sha256:' + 'e'.repeat(64),
    RepoDigests: ['axllent/mailpit@sha256:' + 'd'.repeat(64)],
  })

  it.each([
    ['DESIGN_FIXTURE_MAILPIT_ID', undefined],
    ['DESIGN_FIXTURE_MAILPIT_ID', 'a'.repeat(64)],
    ['DESIGN_FIXTURE_MAILPIT_IMAGE', undefined],
    ['DESIGN_FIXTURE_MAILPIT_NETWORK', undefined],
    ['DESIGN_FIXTURE_MAILPIT_NETWORK', 'bridge'],
    ['DESIGN_FIXTURE_MAILPIT_IMAGE', 'axllent/mailpit:latest'],
    ['DESIGN_FIXTURE_MAILPIT_IMAGE', 'other/mailpit@sha256:' + 'd'.repeat(64)],
    ['EMAIL_SMTP_HOST', 'smtp.acme.example'],
    ['EMAIL_SMTP_HOST', 'localhost'],
    ['EMAIL_SMTP_PORT', '587'],
    ['EMAIL_SMTP_SECURE', 'true'],
    ['EMAIL_FROM', 'different@acme.example'],
    ['EMAIL_SMTP_USER', ''],
    ['EMAIL_SMTP_PASS', 'unexpected-value'],
    ['EMAIL_RESEND_API_KEY', 'unexpected-value'],
    ['RESEND_API_KEY', 'unexpected-value'],
  ])('rejects invalid capture %s before Docker or loaders', (name, value) => {
    const original = process.env
    process.env = { ...capture(), [name!]: value }
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow()
      expect(execFileSync).not.toHaveBeenCalled()
    } finally {
      process.env = original
    }
  })

  it('accepts the fully attested pure capture fixture and checks all effective loaders', () => {
    const original = process.env
    process.env = capture()
    const mock = vi.mocked(execFileSync)
    mock.mockReturnValueOnce(JSON.stringify([...fixtureServices(), mailpit()]))
    mock.mockReturnValueOnce(JSON.stringify([mailpitImage()]))
    for (let i = 0; i < 3; i++)
      mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(process.env))
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).not.toThrow()
      expect(mock.mock.calls[0][1]).toEqual([
        '--host',
        'unix:///var/run/docker.sock',
        'inspect',
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
      ])
      expect(mock.mock.calls[1][0]).toBe('docker')
      expect(mock.mock.calls[1][1]).toEqual([
        '--host',
        'unix:///var/run/docker.sock',
        'image',
        'inspect',
        'sha256:' + 'e'.repeat(64),
      ])
      expect(mock.mock.calls.slice(2).every(([command]) => command === 'bun')).toBe(true)
      expect(mock).toHaveBeenCalledTimes(5)
    } finally {
      process.env = original
    }
  })

  it.each([
    'wrong-id',
    'stopped',
    'unhealthy',
    'missing-healthcheck',
    'missing-healthcheck-test',
    'disabled-healthcheck',
    'shell-healthcheck',
    'different-healthcheck',
    'missing-resolved-image',
    'invalid-resolved-image',
    'different-network',
    'shared-network',
    'mount',
    'wrong-image',
    'entrypoint',
    'args',
    'relay',
    'tls',
    'auth',
    'public-binding',
    'wrong-port',
    'extra-binding',
    'published-ui',
    'named-shared-network',
    'extra-network',
    'dependency-extra-network',
    'network-id-drift',
  ])('rejects capture %s before any environment loader', (fault) => {
    const original = process.env
    process.env = capture()
    const services = fixtureServices()
    const captureService = mailpit()
    if (fault === 'wrong-id') captureService.Id = 'e'.repeat(64)
    if (fault === 'stopped') captureService.State.Running = false
    if (fault === 'unhealthy') captureService.State.Health.Status = 'starting'
    if (fault === 'missing-healthcheck') captureService.Config.Healthcheck = undefined
    if (fault === 'missing-healthcheck-test') captureService.Config.Healthcheck = {}
    if (fault === 'disabled-healthcheck') captureService.Config.Healthcheck = { Test: ['NONE'] }
    if (fault === 'shell-healthcheck') {
      captureService.Config.Healthcheck = { Test: ['CMD-SHELL', '/mailpit readyz'] }
    }
    if (fault === 'different-healthcheck') {
      captureService.Config.Healthcheck = { Test: ['CMD', '/bin/true'] }
    }
    if (fault === 'missing-resolved-image') captureService.Image = undefined
    if (fault === 'invalid-resolved-image') captureService.Image = captureService.Config.Image
    if (fault === 'different-network') captureService.HostConfig.NetworkMode = 'other-job'
    if (fault === 'shared-network') {
      for (const service of services) service.HostConfig.NetworkMode = 'bridge'
      captureService.HostConfig.NetworkMode = 'bridge'
    }
    if (fault === 'named-shared-network') {
      for (const service of [...services, captureService]) {
        service.HostConfig.NetworkMode = 'shared-named-network'
        service.NetworkSettings.Networks = { 'shared-named-network': { NetworkID: 'f'.repeat(64) } }
      }
    }
    if (fault === 'extra-network') {
      captureService.NetworkSettings.Networks.extra = { NetworkID: 'e'.repeat(64) }
    }
    if (fault === 'dependency-extra-network') {
      services[0].NetworkSettings.Networks.extra = { NetworkID: 'e'.repeat(64) }
    }
    if (fault === 'network-id-drift') {
      captureService.NetworkSettings.Networks['job-network'].NetworkID = 'e'.repeat(64)
    }
    if (fault === 'mount') captureService.Mounts.push({ Type: 'volume' })
    if (fault === 'wrong-image') captureService.Config.Image = 'axllent/mailpit:latest'
    if (fault === 'entrypoint') captureService.Config.Entrypoint = ['/bin/sh']
    if (fault === 'args') captureService.Config.Cmd = ['--smtp-relay-config', '/config']
    if (fault === 'relay') captureService.Config.Env.push('MP_SMTP_RELAY_CONFIG=/config')
    if (fault === 'tls') captureService.Config.Env.push('MP_SMTP_TLS_CERT=/cert')
    if (fault === 'auth') captureService.Config.Env.push('MP_SMTP_AUTH=user:password')
    const bindings = captureService.NetworkSettings.Ports['1025/tcp']!
    if (fault === 'public-binding') bindings[0].HostIp = '0.0.0.0'
    if (fault === 'wrong-port') bindings[0].HostPort = '2025'
    if (fault === 'extra-binding') bindings.push({ HostIp: '0.0.0.0', HostPort: '1025' })
    if (fault === 'published-ui') {
      captureService.NetworkSettings.Ports['8025/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '8025' }]
    }
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([...services, captureService]))
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow()
      expect(execFileSync).toHaveBeenCalledTimes(1)
    } finally {
      process.env = original
    }
  })

  it.each(
    ['configured', 'effective'].flatMap((source) =>
      [
        'missing',
        'missing-smtp',
        'null-smtp',
        'empty-smtp',
        'ipv6',
        'public',
        'ipv6-public',
        'unspecified-address',
        'alternate-port',
        'duplicate-smtp',
        'published-ui',
        'published-pop3',
      ].map((fault) => ({ source, fault }))
    )
  )('rejects $source $fault port bindings before inspecting the image', ({ source, fault }) => {
    const original = process.env
    process.env = capture()
    const service = mailpit()
    const ports =
      source === 'configured' ? service.HostConfig.PortBindings! : service.NetworkSettings.Ports
    if (fault === 'missing') {
      if (source === 'configured') service.HostConfig.PortBindings = undefined
      else delete (service.NetworkSettings as { Ports?: unknown }).Ports
    }
    if (fault === 'missing-smtp') delete ports['1025/tcp']
    if (fault === 'null-smtp') ports['1025/tcp'] = null
    if (fault === 'empty-smtp') ports['1025/tcp'] = []
    if (fault === 'ipv6') ports['1025/tcp']![0].HostIp = '::1'
    if (fault === 'public') ports['1025/tcp']![0].HostIp = '0.0.0.0'
    if (fault === 'ipv6-public') ports['1025/tcp']![0].HostIp = '::'
    if (fault === 'unspecified-address') ports['1025/tcp']![0].HostIp = ''
    if (fault === 'alternate-port') ports['1025/tcp']![0].HostPort = '2025'
    if (fault === 'duplicate-smtp') {
      ports['1025/tcp']!.push({ HostIp: '127.0.0.1', HostPort: '1025' })
    }
    if (fault === 'published-ui') ports['8025/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '8025' }]
    if (fault === 'published-pop3') ports['1110/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '1110' }]
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([...fixtureServices(), service]))
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow()
      expect(execFileSync).toHaveBeenCalledTimes(1)
    } finally {
      process.env = original
    }
  })

  it.each([
    ['empty', []],
    ['multiple', [mailpitImage(), mailpitImage()]],
    ['not-an-array', mailpitImage()],
    ['null', null],
    ['missing-result', [null]],
    ['wrong-config-id', [{ ...mailpitImage(), Id: 'sha256:' + 'd'.repeat(64) }]],
    ['missing-digests', [{ Id: mailpitImage().Id }]],
    ['null-digests', [{ ...mailpitImage(), RepoDigests: null }]],
    ['empty-digests', [{ ...mailpitImage(), RepoDigests: [] }]],
    ['string-digests', [{ ...mailpitImage(), RepoDigests: mailpitImage().RepoDigests[0] }]],
    [
      'different-repository',
      [{ ...mailpitImage(), RepoDigests: ['other/mailpit@sha256:' + 'd'.repeat(64)] }],
    ],
    ['tag-only', [{ ...mailpitImage(), RepoDigests: ['axllent/mailpit:v1.31.3'] }]],
    [
      'different-index',
      [{ ...mailpitImage(), RepoDigests: ['axllent/mailpit@sha256:' + 'f'.repeat(64)] }],
    ],
  ])('rejects %s image metadata before loading any effective environment', (_fault, inspected) => {
    const original = process.env
    process.env = capture()
    const mock = vi.mocked(execFileSync)
    mock.mockReturnValueOnce(JSON.stringify([...fixtureServices(), mailpit()]))
    mock.mockReturnValueOnce(JSON.stringify(inspected))
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow()
      expect(mock).toHaveBeenCalledTimes(2)
      expect(mock.mock.calls[1][0]).toBe('docker')
      expect(mock.mock.calls[1][1]).toEqual([
        '--host',
        'unix:///var/run/docker.sock',
        'image',
        'inspect',
        'sha256:' + 'e'.repeat(64),
      ])
    } finally {
      process.env = original
    }
  })

  it('fails closed when local image metadata cannot be inspected', () => {
    const original = process.env
    process.env = capture()
    const mock = vi.mocked(execFileSync)
    mock.mockReturnValueOnce(JSON.stringify([...fixtureServices(), mailpit()]))
    mock.mockImplementationOnce(() => {
      throw new Error('private-image-inspection-output')
    })
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow(
        'Design acceptance requires the isolated GitHub CI fixture'
      )
      expect(mock).toHaveBeenCalledTimes(2)
    } finally {
      process.env = original
    }
  })

  it('accepts matching no-email loader identities', () => {
    const original = process.env
    process.env = fixture()
    const mock = vi.mocked(execFileSync)
    mock.mockReturnValueOnce(JSON.stringify(fixtureServices()))
    for (let i = 0; i < 3; i++) {
      mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(process.env))
    }
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).not.toThrow()
      expect(mock).toHaveBeenCalledTimes(4)
    } finally {
      process.env = original
    }
  })

  const loaderStages = ['helper-environment', 'app-environment', 'migration-environment']

  it.each(loaderStages)('rejects capture introduced only by %s', (stage) => {
    const original = process.env
    process.env = fixture()
    const mock = vi.mocked(execFileSync)
    mock.mockReturnValueOnce(JSON.stringify(fixtureServices()))
    const index = loaderStages.indexOf(stage)
    for (let i = 0; i < index; i++) {
      mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(process.env))
    }
    mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(capture()))
    try {
      expect(() => assertDesignFixtureEnvironmentSync()).toThrow(stage + ' receipt mismatch')
      expect(mock).toHaveBeenCalledTimes(index + 2)
    } finally {
      process.env = original
    }
  })

  const driftCases = [
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'DESIGN_FIXTURE_POSTGRES_ID',
    'DESIGN_FIXTURE_REDIS_ID',
    'DESIGN_FIXTURE_MAILPIT_ID',
    'DESIGN_FIXTURE_MAILPIT_IMAGE',
    'DESIGN_FIXTURE_MAILPIT_NETWORK',
    'no-email',
  ]
  it.each(loaderStages.flatMap((stage) => driftCases.map((key) => ({ stage, key }))))(
    'rejects $key drift in $stage',
    ({ stage, key }) => {
      const original = process.env
      process.env = capture()
      const changed = key === 'no-email' ? fixture() : capture()
      if (key === 'GITHUB_RUN_ID' || key === 'GITHUB_RUN_ATTEMPT') changed[key] = '999'
      else if (key === 'DESIGN_FIXTURE_MAILPIT_IMAGE') {
        changed[key] = 'axllent/mailpit@sha256:' + 'e'.repeat(64)
      } else if (key === 'DESIGN_FIXTURE_MAILPIT_NETWORK') changed[key] = 'different-job'
      else if (key !== 'no-email') changed[key] = 'e'.repeat(64)
      const mock = vi.mocked(execFileSync)
      mock.mockReturnValueOnce(JSON.stringify([...fixtureServices(), mailpit()]))
      mock.mockReturnValueOnce(JSON.stringify([mailpitImage()]))
      const index = loaderStages.indexOf(stage)
      for (let i = 0; i < index; i++) {
        mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(process.env))
      }
      mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(changed))
      try {
        expect(() => assertDesignFixtureEnvironmentSync()).toThrow(stage + ' receipt mismatch')
        expect(mock).toHaveBeenCalledTimes(index + 3)
      } finally {
        process.env = original
      }
    }
  )
})
