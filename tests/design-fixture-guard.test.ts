import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
import {
  assertDesignFixtureEnvironmentSync,
  validateDesignFixtureEnvironment,
  designFixtureEnvironmentReceipt,
  assertDesignFixtureImageServerSync,
  fixtureAppEnvironment,
  validateFixtureAppImage,
  validateFixtureAppContainer,
  type FixtureAppImage,
  type FixtureAppContainer,
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

describe('compiled image app fixture isolation', () => {
  const failure = 'Design acceptance requires the isolated GitHub CI fixture'
  const appId = '7'.repeat(64)
  const imageId = 'sha256:' + '8'.repeat(64)
  const revision = '9'.repeat(40)
  const privateValue = 'private-app-inspection-payload'

  beforeEach(() => vi.mocked(execFileSync).mockReset())

  const captureFixture = (): NodeJS.ProcessEnv => ({
    ...fixture(),
    DESIGN_FIXTURE_MAILPIT_ID: 'c'.repeat(64),
    DESIGN_FIXTURE_MAILPIT_NETWORK: 'job-network',
    // Pure metadata fixture only; this is not a publisher image pin.
    DESIGN_FIXTURE_MAILPIT_IMAGE: 'axllent/mailpit@sha256:' + 'd'.repeat(64),
    EMAIL_SMTP_HOST: '127.0.0.1',
    EMAIL_SMTP_PORT: '1025',
    EMAIL_SMTP_SECURE: 'false',
    EMAIL_FROM: 'Avery Stone <avery.stone@acme.example>',
  })

  const appFixture = (): NodeJS.ProcessEnv => ({
    ...captureFixture(),
    E2E_SERVER_MODE: 'image',
    DESIGN_FIXTURE_APP_ID: appId,
    DESIGN_FIXTURE_APP_IMAGE: imageId,
    DESIGN_FIXTURE_APP_REVISION: revision,
    DESIGN_FIXTURE_APP_MODE: 'development',
    DESIGN_FIXTURE_SHARD: '3',
  })

  const appKeys = [
    'E2E_SERVER_MODE',
    'DESIGN_FIXTURE_APP_ID',
    'DESIGN_FIXTURE_APP_IMAGE',
    'DESIGN_FIXTURE_APP_REVISION',
    'DESIGN_FIXTURE_APP_MODE',
    'DESIGN_FIXTURE_SHARD',
  ] as const

  const runtimeValues: Record<string, string> = {
    NODE_ENV: 'development',
    PORT: '3000',
    HOSTNAME: '127.0.0.1',
    NITRO_HOST: '127.0.0.1',
    SKIP_MIGRATIONS: 'true',
    SEED_DATABASE: 'false',
    DISABLE_TELEMETRY: 'true',
    DATABASE_URL: 'postgresql://postgres:password@localhost:5432/quackback_test',
    REDIS_URL: 'redis://localhost:6379',
    BASE_URL: 'http://localhost:3000',
    TRUSTED_ORIGINS: 'http://acme.localhost:3000',
    SECRET_KEY: 'test-secret-for-ci-only-must-be-at-least-32-characters',
    BETTER_AUTH_SECRET: 'test-secret-for-ci-only-must-be-at-least-32-characters',
    VENTURI_TEAM_EMAIL_DOMAINS: 'example.com,acme.example',
    EMAIL_SMTP_HOST: '127.0.0.1',
    EMAIL_SMTP_PORT: '1025',
    EMAIL_SMTP_SECURE: 'false',
    EMAIL_FROM: 'Avery Stone <avery.stone@acme.example>',
  }

  const appImage = (): FixtureAppImage => ({
    Id: imageId,
    Config: {
      Labels: {
        'org.opencontainers.image.source': 'https://github.com/venturi-systems/quackback',
        'org.opencontainers.image.revision': revision,
      },
      Env: [
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'HOME=/home/quackback',
        'BUN_VERSION=1.4.2',
        'BUN_INSTALL=/usr/local',
        'BUN_INSTALL_CACHE_DIR=/app/.cache',
        'MIGRATIONS_FOLDER=/app/drizzle',
        'NODE_ENV=production',
        'PORT=3000',
        'HOSTNAME=0.0.0.0',
      ],
      Entrypoint: ['./docker-entrypoint.sh'],
      Cmd: null,
      WorkingDir: '/app',
      User: 'quackback',
    },
  })

  const appContainer = (
    env: NodeJS.ProcessEnv = appFixture(),
    image: FixtureAppImage = appImage()
  ): FixtureAppContainer => ({
    Id: appId,
    Image: image.Id,
    State: { Running: true, Status: 'running' },
    Config: {
      ...image.Config,
      Image: image.Id,
      Entrypoint: [...image.Config.Entrypoint],
      Cmd: image.Config.Cmd == null ? image.Config.Cmd : [...image.Config.Cmd],
      Labels: {
        ...image.Config.Labels,
        'systems.venturi.e2e.run': env.GITHUB_RUN_ID!,
        'systems.venturi.e2e.attempt': env.GITHUB_RUN_ATTEMPT!,
        'systems.venturi.e2e.shard': env.DESIGN_FIXTURE_SHARD!,
        'systems.venturi.e2e.mode': 'development',
        'systems.venturi.e2e.postgres': env.DESIGN_FIXTURE_POSTGRES_ID!,
        'systems.venturi.e2e.redis': env.DESIGN_FIXTURE_REDIS_ID!,
        'systems.venturi.e2e.mailpit': env.DESIGN_FIXTURE_MAILPIT_ID!,
      },
      // Construct inspect data independently; do not ask the validator to generate it.
      Env: [
        ...image.Config.Env.filter((entry) => !Object.hasOwn(runtimeValues, entry.split('=')[0])),
        ...Object.entries(runtimeValues).map(([name, value]) => name + '=' + value),
      ],
    },
    HostConfig: {
      NetworkMode: 'host',
      Privileged: false,
      AutoRemove: false,
      CapAdd: null,
      Devices: [],
      PortBindings: {},
    },
    Mounts: [],
  })

  function withEnvironment<T>(env: NodeJS.ProcessEnv, operation: () => T): T {
    const original = process.env
    process.env = env
    try {
      return operation()
    } finally {
      process.env = original
    }
  }

  function replaceValue(entries: string[], key: string, value: string): void {
    const index = entries.findIndex((entry) => entry.startsWith(key + '='))
    expect(index).toBeGreaterThanOrEqual(0)
    entries[index] = key + '=' + value
  }

  function expectPrivateFailure(operation: () => unknown): void {
    let captured: unknown
    try {
      operation()
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(Error)
    const error = captured as Error
    expect(error.message).toContain(failure)
    expect(String(error)).not.toContain(privateValue)
    expect(error.stack).not.toContain(privateValue)
    expect(JSON.stringify(error)).not.toContain(privateValue)
    expect(String(error.cause)).not.toContain(privateValue)
  }

  describe('complete fixture tuple and loader receipts', () => {
    it('accepts the complete image tuple without changing the host environment', () => {
      const env = appFixture()
      const before = { ...env }
      expect(() => validateDesignFixtureEnvironment(env)).not.toThrow()
      expect(fixtureAppEnvironment(env)).toEqual(runtimeValues)
      expect(env).toEqual(before)
      expect(env.NODE_ENV).toBeUndefined()
      expect(execFileSync).not.toHaveBeenCalled()
    })

    it('does not copy arbitrary host values into the app environment', () => {
      const env = { ...appFixture(), PRIVATE_TEST_VALUE: privateValue }
      expect(fixtureAppEnvironment(env)).toEqual(runtimeValues)
      expect(JSON.stringify(fixtureAppEnvironment(env))).not.toContain(privateValue)
    })

    it('keeps production mode forbidden on the host despite a complete image tuple', () => {
      const env = { ...appFixture(), NODE_ENV: 'production' }
      expect(() => validateDesignFixtureEnvironment(env)).toThrow(failure)
      expect(() => fixtureAppEnvironment(env)).toThrow(failure)
      withEnvironment(env, () => {
        expect(() => assertDesignFixtureImageServerSync()).toThrow(failure)
        expect(execFileSync).not.toHaveBeenCalled()
      })
    })

    it.each(appKeys)('rejects a partial tuple missing %s', (key) => {
      const env = appFixture()
      delete env[key]
      expect(() => validateDesignFixtureEnvironment(env)).toThrow(failure)
    })

    it.each(appKeys)('rejects %s introduced without the rest of the tuple', (key) => {
      const env = captureFixture()
      env[key] = appFixture()[key]
      expect(() => validateDesignFixtureEnvironment(env)).toThrow(failure)
    })

    it.each([
      ['E2E_SERVER_MODE', 'dev'],
      ['E2E_SERVER_MODE', ''],
      ['DESIGN_FIXTURE_APP_MODE', 'test'],
      ['DESIGN_FIXTURE_APP_MODE', 'production'],
      ['DESIGN_FIXTURE_APP_ID', 'a'.repeat(64)],
      ['DESIGN_FIXTURE_APP_ID', 'b'.repeat(64)],
      ['DESIGN_FIXTURE_APP_ID', 'c'.repeat(64)],
      ['DESIGN_FIXTURE_APP_ID', '7'.repeat(63)],
      ['DESIGN_FIXTURE_APP_IMAGE', 'quackback:ci'],
      ['DESIGN_FIXTURE_APP_IMAGE', '8'.repeat(64)],
      ['DESIGN_FIXTURE_APP_IMAGE', 'sha256:' + '8'.repeat(63)],
      ['DESIGN_FIXTURE_APP_REVISION', 'HEAD'],
      ['DESIGN_FIXTURE_APP_REVISION', '9'.repeat(39)],
      ['DESIGN_FIXTURE_SHARD', '0'],
      ['DESIGN_FIXTURE_SHARD', '9'],
      ['DESIGN_FIXTURE_SHARD', '03'],
    ])('rejects forged image tuple %s=%s', (key, value) => {
      const env = { ...appFixture(), [key]: value }
      expect(() => validateDesignFixtureEnvironment(env)).toThrow(failure)
    })

    it('requires capture isolation for an image fixture', () => {
      const env = appFixture()
      for (const key of Object.keys(captureFixture())) {
        if (key.startsWith('DESIGN_FIXTURE_MAILPIT_') || key.startsWith('EMAIL_')) delete env[key]
      }
      expect(() => validateDesignFixtureEnvironment(env)).toThrow(failure)
      expect(() => fixtureAppEnvironment(fixture())).toThrow(failure)
    })

    it.each([
      ['DESIGN_FIXTURE_APP_ID', '6'.repeat(64)],
      ['DESIGN_FIXTURE_APP_IMAGE', 'sha256:' + '6'.repeat(64)],
      ['DESIGN_FIXTURE_APP_REVISION', '6'.repeat(40)],
      ['DESIGN_FIXTURE_SHARD', '4'],
    ])('binds a valid changed %s into the effective-loader receipt', (key, value) => {
      const env = appFixture()
      const changed = { ...env, [key]: value }
      expect(() => validateDesignFixtureEnvironment(changed)).not.toThrow()
      expect(designFixtureEnvironmentReceipt(changed)).not.toBe(
        designFixtureEnvironmentReceipt(env)
      )
    })

    it('binds activation and suppression of image mode into the loader receipt', () => {
      expect(designFixtureEnvironmentReceipt(appFixture())).not.toBe(
        designFixtureEnvironmentReceipt(captureFixture())
      )
    })
  })

  describe('immutable production-built image metadata', () => {
    it.each([
      { label: 'null', command: null },
      { label: 'missing', command: undefined },
      { label: 'empty array', command: [] },
    ])('accepts the exact image with $label command', ({ command }) => {
      const image = appImage()
      image.Config.Cmd = command
      expect(() => validateFixtureAppImage(image, imageId, revision)).not.toThrow()
      expect(execFileSync).not.toHaveBeenCalled()
    })

    const imageFaults: Array<[string, (image: FixtureAppImage) => void]> = [
      [
        'different ID',
        (image) => {
          image.Id = 'sha256:' + '6'.repeat(64)
        },
      ],
      [
        'mutable image ID',
        (image) => {
          image.Id = 'quackback:ci'
        },
      ],
      [
        'missing OCI revision',
        (image) => {
          delete image.Config.Labels['org.opencontainers.image.revision']
        },
      ],
      [
        'different OCI revision',
        (image) => {
          image.Config.Labels['org.opencontainers.image.revision'] = '6'.repeat(40)
        },
      ],
      [
        'different OCI source',
        (image) => {
          image.Config.Labels['org.opencontainers.image.source'] = 'https://github.com/acme/other'
        },
      ],
      [
        'missing OCI source',
        (image) => {
          delete image.Config.Labels['org.opencontainers.image.source']
        },
      ],
      [
        'entrypoint override',
        (image) => {
          image.Config.Entrypoint = ['/bin/sh']
        },
      ],
      [
        'extra entrypoint argument',
        (image) => {
          image.Config.Entrypoint.push('-c')
        },
      ],
      [
        'command override',
        (image) => {
          image.Config.Cmd = ['bun', 'unexpected.mjs']
        },
      ],
      [
        'string command',
        (image) => {
          image.Config.Cmd = '' as unknown as string[]
        },
      ],
      [
        'object command',
        (image) => {
          image.Config.Cmd = {} as unknown as string[]
        },
      ],
      [
        'different working directory',
        (image) => {
          image.Config.WorkingDir = '/other'
        },
      ],
      [
        'root user',
        (image) => {
          image.Config.User = 'root'
        },
      ],
      [
        'development build mode',
        (image) => {
          replaceValue(image.Config.Env, 'NODE_ENV', 'development')
        },
      ],
      [
        'test build mode',
        (image) => {
          replaceValue(image.Config.Env, 'NODE_ENV', 'test')
        },
      ],
      [
        'different image port',
        (image) => {
          replaceValue(image.Config.Env, 'PORT', '3001')
        },
      ],
      [
        'different image hostname',
        (image) => {
          replaceValue(image.Config.Env, 'HOSTNAME', '127.0.0.1')
        },
      ],
      [
        'duplicate default',
        (image) => {
          image.Config.Env.push('NODE_ENV=production')
        },
      ],
      [
        'private default',
        (image) => {
          image.Config.Env.push('AWS_SECRET_ACCESS_KEY=' + privateValue)
        },
      ],
      [
        'prototype-name default',
        (image) => {
          image.Config.Env.push('__proto__=' + privateValue)
        },
      ],
      [
        'missing default',
        (image) => {
          image.Config.Env = image.Config.Env.filter((entry) => !entry.startsWith('NODE_ENV='))
        },
      ],
      [
        'malformed default',
        (image) => {
          image.Config.Env.push('MALFORMED')
        },
      ],
      [
        'non-array defaults',
        (image) => {
          image.Config.Env = null as unknown as string[]
        },
      ],
    ]

    it.each(imageFaults)('rejects %s without disclosing image data', (_name, alter) => {
      const image = appImage()
      alter(image)
      expectPrivateFailure(() => validateFixtureAppImage(image, imageId, revision))
    })

    it.each([
      ['quackback:ci', revision],
      [imageId, 'HEAD'],
      [imageId, '6'.repeat(40)],
    ])('rejects an unbound expected image %s or revision %s', (expectedImage, expectedRevision) => {
      expect(() => validateFixtureAppImage(appImage(), expectedImage, expectedRevision)).toThrow(
        failure
      )
    })

    it('rejects matching image and container commands when the image itself has arguments', () => {
      const image = appImage()
      image.Config.Cmd = ['bun', 'unexpected.mjs']
      const container = appContainer(appFixture(), image)
      expect(() =>
        validateFixtureAppContainer(appFixture(), image, container, revision, 'running')
      ).toThrow(failure)
    })
  })

  describe('effective app configuration', () => {
    it('accepts the complete compiled development-mode app', () => {
      const image = appImage()
      expect(() =>
        validateFixtureAppContainer(appFixture(), image, appContainer(), revision, 'running')
      ).not.toThrow()
      expect(execFileSync).not.toHaveBeenCalled()
    })

    it.each(Object.keys(runtimeValues))(
      'rejects missing actual %s without host fallback',
      (key) => {
        const container = appContainer()
        container.Config.Env = container.Config.Env.filter((entry) => !entry.startsWith(key + '='))
        expect(() =>
          validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'running')
        ).toThrow(failure)
      }
    )

    it.each([
      ['NODE_ENV', 'production'],
      ['NODE_ENV', 'test'],
      ['PORT', '3001'],
      ['HOSTNAME', '0.0.0.0'],
      ['NITRO_HOST', '0.0.0.0'],
      ['SKIP_MIGRATIONS', 'false'],
      ['SEED_DATABASE', 'true'],
      ['DISABLE_TELEMETRY', 'false'],
      ['DATABASE_URL', 'postgresql://postgres:password@other.acme.example:5432/quackback_test'],
      ['REDIS_URL', 'redis://other.acme.example:6379'],
      ['BASE_URL', 'https://other.acme.example'],
      ['TRUSTED_ORIGINS', 'http://acme.localhost:3000,https://other.acme.example'],
      ['SECRET_KEY', privateValue],
      ['BETTER_AUTH_SECRET', privateValue],
      ['VENTURI_TEAM_EMAIL_DOMAINS', 'example.com'],
      ['EMAIL_SMTP_HOST', 'smtp.acme.example'],
      ['EMAIL_SMTP_PORT', '587'],
      ['EMAIL_SMTP_SECURE', 'true'],
      ['EMAIL_FROM', 'Jordan Ellis <jordan.ellis@acme.example>'],
    ])('rejects actual %s drift without disclosing the value', (key, value) => {
      const container = appContainer()
      replaceValue(container.Config.Env, key, value)
      expectPrivateFailure(() =>
        validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'running')
      )
    })

    it.each([
      'DATABASE_URL=' + runtimeValues.DATABASE_URL,
      'NODE_ENV=development',
      'NODE_ENV=test',
      'AWS_SECRET_ACCESS_KEY=' + privateValue,
      'PRIVATE_TEST_VALUE=' + privateValue,
      'OTEL_EXPORTER_OTLP_ENDPOINT=https://telemetry.acme.example',
      'EMAIL_SMTP_USER=' + privateValue,
      'EMAIL_SMTP_PASS=' + privateValue,
      'EMAIL_RESEND_API_KEY=' + privateValue,
      'RESEND_API_KEY=' + privateValue,
      'HTTP_PROXY=http://proxy.acme.example',
      'SOURCE_COMMIT=' + '6'.repeat(40),
      'GITHUB_RUN_ID=999',
      'DESIGN_FIXTURE_SHARD=4',
      '__proto__=' + privateValue,
      '__proto__=',
      'MALFORMED',
      '=MALFORMED',
      'BAD-NAME=' + privateValue,
    ])('rejects duplicate, unexpected or malformed actual environment entry %s', (entry) => {
      const container = appContainer()
      container.Config.Env.push(entry)
      expectPrivateFailure(() =>
        validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'running')
      )
    })

    it.each([null, {}, 'NODE_ENV=development', [null]].map((entries) => ({ entries })))(
      'rejects malformed raw container environment $entries',
      ({ entries }) => {
        const container = appContainer()
        container.Config.Env = entries as unknown as string[]
        expectPrivateFailure(() =>
          validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'running')
        )
      }
    )

    const containerFaults: Array<[string, (container: FixtureAppContainer) => void]> = [
      [
        'wrong container ID',
        (container) => {
          container.Id = '6'.repeat(64)
        },
      ],
      [
        'wrong resolved image',
        (container) => {
          container.Image = 'sha256:' + '6'.repeat(64)
        },
      ],
      [
        'mutable configured image',
        (container) => {
          container.Config.Image = 'quackback:ci'
        },
      ],
      [
        'wrong configured image',
        (container) => {
          container.Config.Image = 'sha256:' + '6'.repeat(64)
        },
      ],
      [
        'different working directory',
        (container) => {
          container.Config.WorkingDir = '/other'
        },
      ],
      [
        'root user',
        (container) => {
          container.Config.User = 'root'
        },
      ],
      [
        'entrypoint override',
        (container) => {
          container.Config.Entrypoint = ['/bin/sh']
        },
      ],
      [
        'command override',
        (container) => {
          container.Config.Cmd = ['bun', 'unexpected.mjs']
        },
      ],
      [
        'bridge network',
        (container) => {
          container.HostConfig.NetworkMode = 'bridge'
        },
      ],
      [
        'privileged container',
        (container) => {
          container.HostConfig.Privileged = true
        },
      ],
      [
        'automatic removal',
        (container) => {
          container.HostConfig.AutoRemove = true
        },
      ],
      [
        'added capabilities',
        (container) => {
          container.HostConfig.CapAdd = ['SYS_ADMIN']
        },
      ],
      [
        'device mapping',
        (container) => {
          container.HostConfig.Devices = [{ PathOnHost: '/dev/null' }]
        },
      ],
      [
        'port publishing',
        (container) => {
          container.HostConfig.PortBindings = { '3000/tcp': [{ HostPort: '3000' }] }
        },
      ],
      [
        'bind mount',
        (container) => {
          container.Mounts = [{ Type: 'bind', Destination: '/app' }]
        },
      ],
      [
        'volume mount',
        (container) => {
          container.Mounts = [{ Type: 'volume', Destination: '/app' }]
        },
      ],
      [
        'missing mounts',
        (container) => {
          container.Mounts = null as unknown as unknown[]
        },
      ],
      [
        'stopped app',
        (container) => {
          container.State = { Running: false, Status: 'exited' }
        },
      ],
    ]

    it.each(containerFaults)('rejects %s', (_name, alter) => {
      const container = appContainer()
      alter(container)
      expect(() =>
        validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'running')
      ).toThrow(failure)
    })

    it.each(['run', 'attempt', 'shard', 'mode', 'postgres', 'redis', 'mailpit'])(
      'rejects actual ownership label %s drift',
      (name) => {
        const container = appContainer()
        container.Config.Labels['systems.venturi.e2e.' + name] = privateValue
        expectPrivateFailure(() =>
          validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'running')
        )
      }
    )

    it.each(['created', 'running', 'retained'] as const)(
      'rejects host source revision drift during %s validation',
      (phase) => {
        const container = appContainer()
        if (phase === 'created') container.State = { Running: false, Status: 'created' }
        expect(() =>
          validateFixtureAppContainer(appFixture(), appImage(), container, '6'.repeat(40), phase)
        ).toThrow(failure)
      }
    )

    it('accepts created metadata before startup and refuses to call it running', () => {
      const container = appContainer()
      container.State = { Running: false, Status: 'created' }
      expect(() =>
        validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'created')
      ).not.toThrow()
      expect(() =>
        validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'running')
      ).toThrow(failure)
      expect(() =>
        validateFixtureAppContainer(appFixture(), appImage(), appContainer(), revision, 'created')
      ).toThrow(failure)
    })

    it.each([
      { Running: true, Status: 'running' },
      { Running: false, Status: 'created' },
      { Running: false, Status: 'exited' },
      { Running: false, Status: 'dead' },
    ])('accepts retained owned metadata with valid state %s', (state) => {
      const container = appContainer()
      container.State = state
      expect(() =>
        validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'retained')
      ).not.toThrow()
    })

    it.each([
      undefined,
      null,
      {},
      { Running: undefined, Status: 'exited' },
      { Running: 'false', Status: 'exited' },
      { Running: 0, Status: 'exited' },
      { Running: false, Status: undefined },
      { Running: false, Status: 0 },
      { Running: true, Status: 'exited' },
      { Running: false, Status: 'running' },
      { Running: true, Status: 'created' },
      { Running: false, Status: 'unknown' },
    ])('rejects malformed or contradictory retained state %s', (state) => {
      const container = appContainer()
      container.State = state as FixtureAppContainer['State']
      expect(() =>
        validateFixtureAppContainer(appFixture(), appImage(), container, revision, 'retained')
      ).toThrow(failure)
    })
  })

  describe('browser-only image gate and service-only restoration', () => {
    function queueAppInspection(
      container: unknown = [appContainer()],
      image: unknown = [appImage()],
      checkedRevision = revision
    ): void {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(checkedRevision + '\n')
        .mockReturnValueOnce(JSON.stringify(container))
        .mockReturnValueOnce(JSON.stringify(image))
    }

    const captureServices = () => [
      ...fixtureServices(),
      {
        Id: 'c'.repeat(64),
        Image: 'sha256:' + 'e'.repeat(64),
        State: { Running: true, Health: { Status: 'healthy' } },
        HostConfig: {
          NetworkMode: 'job-network',
          PortBindings: { '1025/tcp': [{ HostIp: '127.0.0.1', HostPort: '1025' }] },
        },
        Mounts: [],
        NetworkSettings: {
          Networks: { 'job-network': { NetworkID: 'f'.repeat(64) } },
          Ports: { '1025/tcp': [{ HostIp: '127.0.0.1', HostPort: '1025' }] },
        },
        Config: {
          Image: 'axllent/mailpit@sha256:' + 'd'.repeat(64),
          Entrypoint: ['/mailpit'],
          Cmd: [],
          Env: ['PATH=/usr/local/bin:/usr/bin:/bin'],
          Healthcheck: { Test: ['CMD', '/mailpit', 'readyz'] },
        },
      },
    ]

    function queueServiceInspection(): void {
      vi.mocked(execFileSync)
        .mockReturnValueOnce(JSON.stringify(captureServices()))
        .mockReturnValueOnce(
          JSON.stringify([
            {
              Id: 'sha256:' + 'e'.repeat(64),
              RepoDigests: ['axllent/mailpit@sha256:' + 'd'.repeat(64)],
            },
          ])
        )
    }

    it('requires actual git HEAD and both local inspect results for browser readiness', () => {
      withEnvironment(appFixture(), () => {
        queueAppInspection()
        expect(() => assertDesignFixtureImageServerSync()).not.toThrow()
        const calls = vi.mocked(execFileSync).mock.calls
        expect(calls).toHaveLength(3)
        expect(calls[0][0]).toBe('git')
        expect(calls[0][1]).toEqual(['rev-parse', 'HEAD'])
        expect(calls[1][0]).toBe('docker')
        expect(calls[1][1]).toEqual(['--host', 'unix:///var/run/docker.sock', 'inspect', appId])
        expect(calls[2][0]).toBe('docker')
        expect(calls[2][1]).toEqual([
          '--host',
          'unix:///var/run/docker.sock',
          'image',
          'inspect',
          imageId,
        ])
      })
    })

    it('rejects image mode missing from the browser gate before subprocesses', () => {
      withEnvironment(captureFixture(), () => {
        expect(() => assertDesignFixtureImageServerSync()).toThrow(failure)
        expect(execFileSync).not.toHaveBeenCalled()
      })
    })

    it('does not accept image labels in place of the actual checked-out revision', () => {
      withEnvironment(appFixture(), () => {
        queueAppInspection([appContainer()], [appImage()], '6'.repeat(40))
        expect(() => assertDesignFixtureImageServerSync()).toThrow(failure)
        expect(execFileSync).toHaveBeenCalledTimes(3)
      })
    })

    it('rejects a stopped app at the browser gate', () => {
      withEnvironment(appFixture(), () => {
        const container = appContainer()
        container.State = { Running: false, Status: 'exited' }
        queueAppInspection([container])
        expect(() => assertDesignFixtureImageServerSync()).toThrow(failure)
      })
    })

    it.each(['container', 'image'])('rejects malformed %s inspection output', (target) => {
      for (const inspected of [null, {}, [], [null], [appContainer(), appContainer()]]) {
        vi.mocked(execFileSync).mockReset()
        withEnvironment(appFixture(), () => {
          queueAppInspection(
            target === 'container' ? inspected : [appContainer()],
            target === 'image' ? inspected : [appImage()]
          )
          expect(() => assertDesignFixtureImageServerSync()).toThrow(failure)
        })
      }
    })

    it.each([0, 1, 2])('sanitizes subprocess failure at inspection stage %s', (stage) => {
      withEnvironment(appFixture(), () => {
        const mock = vi.mocked(execFileSync)
        if (stage > 0) mock.mockReturnValueOnce(revision + '\n')
        if (stage > 1) mock.mockReturnValueOnce(JSON.stringify([appContainer()]))
        mock.mockImplementationOnce(() => {
          throw Object.assign(new Error(privateValue), {
            code: 'ENOENT',
            stderr: privateValue,
            stdout: privateValue,
            env: { PRIVATE_TEST_VALUE: privateValue },
          })
        })
        expectPrivateFailure(() => assertDesignFixtureImageServerSync())
        expect(mock).toHaveBeenCalledTimes(stage + 1)
      })
    })

    it('keeps service-only fixture restoration independent of app inspection', () => {
      withEnvironment(appFixture(), () => {
        queueServiceInspection()
        const mock = vi.mocked(execFileSync)
        for (let index = 0; index < 3; index++) {
          mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(process.env))
        }
        expect(() => assertDesignFixtureEnvironmentSync()).not.toThrow()
        expect(mock).toHaveBeenCalledTimes(5)
        expect(mock.mock.calls[0][1]).toEqual([
          '--host',
          'unix:///var/run/docker.sock',
          'inspect',
          'a'.repeat(64),
          'b'.repeat(64),
          'c'.repeat(64),
        ])
        expect(mock.mock.calls.slice(2).every(([command]) => command === 'bun')).toBe(true)
        expect(mock.mock.calls.every(([command]) => command !== 'git')).toBe(true)
        expect(mock.mock.calls.every(([, args]) => !JSON.stringify(args).includes(appId))).toBe(
          true
        )
        expect(mock.mock.calls.every(([, args]) => !JSON.stringify(args).includes(imageId))).toBe(
          true
        )
      })
    })

    const loaderStages = ['helper-environment', 'app-environment', 'migration-environment']
    const loaderDrifts: Array<[string, (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv]> = [
      ['app ID', (env) => ({ ...env, DESIGN_FIXTURE_APP_ID: '6'.repeat(64) })],
      ['image ID', (env) => ({ ...env, DESIGN_FIXTURE_APP_IMAGE: 'sha256:' + '6'.repeat(64) })],
      ['source', (env) => ({ ...env, DESIGN_FIXTURE_APP_REVISION: '6'.repeat(40) })],
      ['shard', (env) => ({ ...env, DESIGN_FIXTURE_SHARD: '4' })],
      ['run', (env) => ({ ...env, GITHUB_RUN_ID: '999' })],
      ['attempt', (env) => ({ ...env, GITHUB_RUN_ATTEMPT: '2' })],
      ['image suppression', () => captureFixture()],
    ]

    it.each(
      loaderStages.flatMap((stage) => loaderDrifts.map(([name, alter]) => ({ stage, name, alter })))
    )('rejects $name drift in the $stage effective loader', ({ stage, alter }) => {
      withEnvironment(appFixture(), () => {
        queueServiceInspection()
        const mock = vi.mocked(execFileSync)
        const index = loaderStages.indexOf(stage)
        for (let previous = 0; previous < index; previous++) {
          mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(process.env))
        }
        mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(alter(process.env)))
        expect(() => assertDesignFixtureEnvironmentSync()).toThrow(stage + ' receipt mismatch')
        expect(mock).toHaveBeenCalledTimes(index + 3)
      })
    })

    it.each(loaderStages)('rejects image activation only inside %s', (stage) => {
      withEnvironment(captureFixture(), () => {
        queueServiceInspection()
        const mock = vi.mocked(execFileSync)
        const index = loaderStages.indexOf(stage)
        for (let previous = 0; previous < index; previous++) {
          mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(process.env))
        }
        mock.mockReturnValueOnce(designFixtureEnvironmentReceipt(appFixture()))
        expect(() => assertDesignFixtureEnvironmentSync()).toThrow(stage + ' receipt mismatch')
        expect(mock).toHaveBeenCalledTimes(index + 3)
      })
    })
  })
})
