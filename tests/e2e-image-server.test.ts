import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  finishImageServer,
  ImageServerProbeError,
  startImageServer,
  verifyCompiledDevelopmentMode,
  type ImageServerIO,
} from '../apps/web/e2e/scripts/image-server'
import {
  designFixtureEnvironmentReceipt,
  validateDesignFixtureEnvironment,
  type FixtureAppContainer,
  type FixtureAppImage,
} from '../apps/web/e2e/utils/design-fixture-guard'

const SOURCE = '1'.repeat(40)
const TREE = '2'.repeat(40)
const IMAGE = 'sha256:' + '3'.repeat(64)
const APP = 'd'.repeat(64)
const STARTED = '2026-10-03T00:00:00.123456789Z'
const URL = 'http://acme.localhost:3000'
const OTP = URL + '/api/auth/email-otp/send-verification-otp'

function fixture(): NodeJS.ProcessEnv {
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'venturi-systems/quackback',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    E2E_IMAGE_SHARD: '3',
    DESIGN_FIXTURE_POSTGRES_ID: 'a'.repeat(64),
    DESIGN_FIXTURE_REDIS_ID: 'b'.repeat(64),
    DESIGN_FIXTURE_MAILPIT_ID: 'c'.repeat(64),
    DESIGN_FIXTURE_MAILPIT_IMAGE: 'axllent/mailpit@sha256:' + '4'.repeat(64),
    DESIGN_FIXTURE_MAILPIT_NETWORK: 'github-job-network',
    DATABASE_URL: 'postgresql://postgres:password@localhost:5432/quackback_test',
    REDIS_URL: 'redis://localhost:6379',
    BASE_URL: 'http://localhost:3000',
    TRUSTED_ORIGINS: URL,
    SECRET_KEY: 'test-secret-for-ci-only-must-be-at-least-32-characters',
    BETTER_AUTH_SECRET: 'test-secret-for-ci-only-must-be-at-least-32-characters',
    VENTURI_TEAM_EMAIL_DOMAINS: 'example.com,acme.example',
    EMAIL_SMTP_HOST: '127.0.0.1',
    EMAIL_SMTP_PORT: '1025',
    EMAIL_SMTP_SECURE: 'false',
    EMAIL_FROM: 'Avery Stone <avery.stone@acme.example>',
  }
}

function makeHarness() {
  const env = fixture()
  const events: string[] = []
  const writes = new Map<string, string>([
    [
      'tested-tree.json',
      JSON.stringify({
        schema: 1,
        run_id: 123,
        run_attempt: 2,
        shard: 3,
        commit: SOURCE,
        tree: TREE,
        // Source receipt extras must never leak through compact app metadata.
        unexpected: 'private-extra-value',
      }),
    ],
  ])
  const image: FixtureAppImage = {
    Id: IMAGE,
    Config: {
      Labels: {
        'org.opencontainers.image.source': 'https://github.com/venturi-systems/quackback',
        'org.opencontainers.image.revision': SOURCE,
      },
      Env: [
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'NODE_ENV=production',
        'PORT=3000',
        'HOSTNAME=0.0.0.0',
        'BUN_INSTALL_CACHE_DIR=/app/.cache',
        'MIGRATIONS_FOLDER=/app/drizzle',
      ],
      Entrypoint: ['./docker-entrypoint.sh'],
      Cmd: null,
      WorkingDir: '/app',
      User: 'quackback',
    },
  }
  const appValues = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    BUN_INSTALL_CACHE_DIR: '/app/.cache',
    MIGRATIONS_FOLDER: '/app/drizzle',
    NODE_ENV: 'development',
    PORT: '3000',
    HOSTNAME: '127.0.0.1',
    NITRO_HOST: '127.0.0.1',
    SKIP_MIGRATIONS: 'true',
    SEED_DATABASE: 'false',
    DISABLE_TELEMETRY: 'true',
    DATABASE_URL: env.DATABASE_URL!,
    REDIS_URL: env.REDIS_URL!,
    BASE_URL: env.BASE_URL!,
    TRUSTED_ORIGINS: env.TRUSTED_ORIGINS!,
    SECRET_KEY: env.SECRET_KEY!,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET!,
    VENTURI_TEAM_EMAIL_DOMAINS: env.VENTURI_TEAM_EMAIL_DOMAINS!,
    EMAIL_SMTP_HOST: env.EMAIL_SMTP_HOST!,
    EMAIL_SMTP_PORT: env.EMAIL_SMTP_PORT!,
    EMAIL_SMTP_SECURE: env.EMAIL_SMTP_SECURE!,
    EMAIL_FROM: env.EMAIL_FROM!,
  }
  const container: FixtureAppContainer = {
    Id: APP,
    Image: IMAGE,
    State: { Running: false, Status: 'created' },
    RestartCount: 0,
    Config: {
      ...structuredClone(image.Config),
      Image: IMAGE,
      Env: Object.entries(appValues).map(([key, value]) => key + '=' + value),
      Labels: {
        ...image.Config.Labels,
        'systems.venturi.e2e.run': '123',
        'systems.venturi.e2e.attempt': '2',
        'systems.venturi.e2e.shard': '3',
        'systems.venturi.e2e.mode': 'development',
        'systems.venturi.e2e.postgres': env.DESIGN_FIXTURE_POSTGRES_ID!,
        'systems.venturi.e2e.redis': env.DESIGN_FIXTURE_REDIS_ID!,
        'systems.venturi.e2e.mailpit': env.DESIGN_FIXTURE_MAILPIT_ID!,
      },
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
  }
  const io: ImageServerIO = {
    env,
    cidfile: '/runner/e2e-evidence/image-server.cid',
    preflight: vi.fn(() => {
      events.push('preflight')
      validateDesignFixtureEnvironment(env)
    }),
    command: vi.fn((command, args) => {
      if (command === 'git') {
        events.push('git:' + args.join(' '))
        if (args.join(' ') === 'rev-parse HEAD') return SOURCE
        if (args.join(' ') === 'rev-parse HEAD^{tree}') return TREE
        if (args.join(' ') === 'diff --exit-code HEAD --') return ''
        throw new Error('Unexpected git command')
      }
      expect(command).toBe('docker')
      expect(args.slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock'])
      const words = args.slice(2)
      events.push('docker:' + words[0])
      if (words[0] === 'image') {
        expect(words).toEqual(['image', 'inspect', IMAGE])
        return JSON.stringify([image])
      }
      if (words[0] === 'inspect') {
        expect(words).toEqual(['inspect', APP])
        events.push('inspect:' + container.State.Status)
        return JSON.stringify([container])
      }
      if (words[0] === 'create') {
        expect(words[words.indexOf('--cidfile') + 1]).toBe(io.cidfile)
        writes.set('image-server.cid', APP + '\n')
        return APP + '\n'
      }
      if (words[0] === 'start') {
        expect(words).toEqual(['start', APP])
        container.State = { Running: true, Status: 'running', Pid: 1234, StartedAt: STARTED }
        return APP
      }
      if (words[0] === 'stop') {
        expect(words).toEqual(['stop', '--time', '10', APP])
        container.State = { Running: false, Status: 'exited' }
        return APP
      }
      if (words[0] === 'logs') {
        expect(words).toEqual(['logs', APP])
        return 'fixture startup log\n'
      }
      throw new Error('Unexpected Docker command')
    }),
    read: vi.fn((name) => writes.get(name)),
    write: vi.fn((name, value) => {
      events.push('write:' + name)
      if (writes.has(name)) throw new Error('Refusing evidence overwrite')
      writes.set(name, JSON.stringify(value))
    }),
    writeLog: vi.fn((value) => {
      events.push('write-log')
      writes.set('image-server.log', value)
    }),
    exportEnvironment: vi.fn((values) => {
      events.push('export')
      Object.assign(env, values)
    }),
    assertPortFree: vi.fn(async () => {
      events.push('port-free')
    }),
    wait: vi.fn(async () => {
      events.push('ready')
    }),
    verifyDevelopmentMode: vi.fn(async () => {
      events.push('probe')
      return { requests: 4 as const, elapsed_ms: 25, origin_rejected: true as const }
    }),
  }
  const receipt = (name: string) => JSON.parse(writes.get(name)!) as Record<string, unknown>
  const dockerOperations = () =>
    vi
      .mocked(io.command)
      .mock.calls.filter(([command]) => command === 'docker')
      .map(([, args]) => args.slice(2))
  return { io, env, image, container, events, writes, receipt, dockerOperations }
}

describe('job-owned compiled application lifecycle', () => {
  it('inspects before startup and exports identity only after runtime proof and a running recheck', async () => {
    const h = makeHarness()
    await startImageServer(IMAGE, h.io)
    const create = h.dockerOperations().find(([command]) => command === 'create')!
    expect(create).toContain('--pull=never')
    expect(create.at(-1)).toBe(IMAGE)
    expect(create).toContain('NODE_ENV=development')
    expect(create).toContain('SKIP_MIGRATIONS=true')
    expect(create).toContain('SEED_DATABASE=false')
    expect(create).toContain('DISABLE_TELEMETRY=true')
    expect(create).toContain('HOSTNAME=127.0.0.1')
    expect(create).toContain('NITRO_HOST=127.0.0.1')
    expect(create).toContain('--cidfile')
    expect(create).not.toContain('--env-file')
    expect(create).not.toContain('--rm')
    expect(h.events.indexOf('preflight')).toBeLessThan(h.events.indexOf('docker:create'))
    expect(h.events.indexOf('port-free')).toBeLessThan(h.events.indexOf('docker:create'))
    expect(h.events.indexOf('inspect:created')).toBeLessThan(h.events.indexOf('docker:start'))
    expect(h.events.indexOf('write:image-server-owned.json')).toBeLessThan(
      h.events.indexOf('docker:start')
    )
    expect(h.events.lastIndexOf('inspect:running')).toBeGreaterThan(h.events.indexOf('probe'))
    expect(h.events.indexOf('export')).toBeGreaterThan(h.events.lastIndexOf('inspect:running'))
    expect(h.receipt('image-server-ready.json')).toMatchObject({
      schema: 1,
      run_id: 123,
      run_attempt: 2,
      shard: 3,
      commit: SOURCE,
      tree: TREE,
      image_id: IMAGE,
      container_id: APP,
      mode: 'development',
      ready: true,
      inspected_before_start: true,
      runtime_development_mode_verified: true,
      development_mode_probe: { requests: 4, elapsed_ms: 25, origin_rejected: true },
      process_continuity_verified: true,
      process_identity: { pid: 1234, started_at: STARTED, restart_count: 0 },
    })
    expect(h.env.DESIGN_FIXTURE_APP_MODE).toBe('development')
    expect(h.env.DESIGN_FIXTURE_APP_REVISION).toBe(SOURCE)
    expect(h.env.E2E_SERVER_MODE).toBe('image')
    expect(h.receipt('image-server-ready.json').fixture_receipt).toBe(
      designFixtureEnvironmentReceipt(h.env)
    )
    const metadata = [...h.writes]
      .filter(([name]) => name.startsWith('image-server-'))
      .map(([, value]) => value)
      .join('\n')
    for (const privateValue of [
      'private-extra-value',
      'DATABASE_URL',
      'SECRET_KEY',
      h.env.DATABASE_URL!,
      h.env.SECRET_KEY!,
    ])
      expect(metadata).not.toContain(privateValue)
  })

  it.each([
    'guard',
    'source',
    'dirty-tree',
    'image',
    'port',
    'created-env',
    'readiness',
    'probe',
    'app-exit',
  ])(
    'fails closed on %s without publishing ready identity or starting an uninspected image',
    async (fault) => {
      const h = makeHarness()
      const originalCommand = h.io.command
      if (fault === 'guard')
        vi.mocked(h.io.preflight).mockImplementation(() => {
          throw new Error('guard')
        })
      if (fault === 'source') {
        h.writes.set(
          'tested-tree.json',
          JSON.stringify({ ...h.receipt('tested-tree.json'), commit: '9'.repeat(40) })
        )
      }
      if (fault === 'dirty-tree')
        h.io.command = vi.fn((name, args) => {
          if (name === 'git' && args[0] === 'diff') throw new Error('dirty')
          return originalCommand(name, args)
        })
      if (fault === 'image')
        h.image.Config.Labels['org.opencontainers.image.revision'] = '9'.repeat(40)
      if (fault === 'port') vi.mocked(h.io.assertPortFree).mockRejectedValue(new Error('busy'))
      if (fault === 'created-env') h.container.Config.Env.push('HTTP_PROXY=private-proxy-value')
      if (fault === 'readiness') vi.mocked(h.io.wait).mockRejectedValue(new Error('not ready'))
      if (fault === 'probe')
        vi.mocked(h.io.verifyDevelopmentMode).mockRejectedValue(new Error('not development'))
      if (fault === 'app-exit')
        vi.mocked(h.io.verifyDevelopmentMode).mockImplementation(async () => {
          h.container.State = { Running: false, Status: 'exited' }
          return { requests: 4, elapsed_ms: 25, origin_rejected: true }
        })
      await expect(startImageServer(IMAGE, h.io)).rejects.toThrow()
      expect(h.io.exportEnvironment).not.toHaveBeenCalled()
      expect(h.writes.has('image-server-ready.json')).toBe(false)
      if (['guard', 'source', 'dirty-tree', 'image', 'port', 'created-env'].includes(fault)) {
        expect(h.dockerOperations().some(([operation]) => operation === 'start')).toBe(false)
      }
      if (['guard', 'source', 'dirty-tree', 'image', 'port'].includes(fault)) {
        expect(h.dockerOperations().some(([operation]) => operation === 'create')).toBe(false)
      }
    }
  )

  it.each([
    'tag',
    'prior-app',
    'prior-cid',
    'prior-attempt',
    'partial-mode',
    'foreign-daemon',
    'source-receipt-run',
    'source-receipt-shard',
  ])('rejects %s before app creation', async (fault) => {
    const h = makeHarness()
    let id = IMAGE
    if (fault === 'tag') id = 'quackback:latest'
    if (fault === 'prior-app') h.writes.set('image-server-owned.json', '{}')
    if (fault === 'prior-cid') h.writes.set('image-server.cid', APP)
    if (fault === 'prior-attempt') h.writes.set('image-server-attempt.json', '{}')
    if (fault === 'partial-mode') h.env.E2E_SERVER_MODE = 'image'
    if (fault === 'foreign-daemon') h.env.DOCKER_HOST = 'tcp://other.acme.example:2375'
    if (fault === 'source-receipt-run' || fault === 'source-receipt-shard') {
      h.writes.set(
        'tested-tree.json',
        JSON.stringify({
          ...h.receipt('tested-tree.json'),
          [fault === 'source-receipt-run' ? 'run_id' : 'shard']: 8,
        })
      )
    }
    await expect(startImageServer(id, h.io)).rejects.toThrow()
    expect(h.dockerOperations().some(([operation]) => operation === 'create')).toBe(false)
    expect(h.io.exportEnvironment).not.toHaveBeenCalled()
  })

  it('captures logs and stops only the positively bound app without removing it', async () => {
    const h = makeHarness()
    await startImageServer(IMAGE, h.io)
    finishImageServer(h.io)
    expect(h.io.writeLog).toHaveBeenCalledWith('fixture startup log\n')
    expect(h.dockerOperations().filter(([op]) => op === 'stop')).toEqual([
      ['stop', '--time', '10', APP],
    ])
    expect(h.dockerOperations().some(([op]) => ['rm', 'prune', 'kill'].includes(op))).toBe(false)
    expect(h.receipt('image-server-after.json')).toMatchObject({
      container_id: APP,
      image_id: IMAGE,
      configuration_verified: true,
      running_before_stop: true,
      stopped: true,
      source_unchanged: true,
      problems: [],
    })
  })

  it('keeps unknown retained metadata out of shutdown receipts', async () => {
    const h = makeHarness()
    await startImageServer(IMAGE, h.io)
    h.writes.set(
      'image-server-owned.json',
      JSON.stringify({
        ...h.receipt('image-server-owned.json'),
        unexpected: 'private-retained-value',
      })
    )
    finishImageServer(h.io)
    expect(h.writes.get('image-server-after.json')).not.toContain('private-retained-value')
  })

  it('can stop its attested container after the startup probe failed before environment export', async () => {
    const h = makeHarness()
    vi.mocked(h.io.verifyDevelopmentMode).mockRejectedValue(new Error('probe'))
    await expect(startImageServer(IMAGE, h.io)).rejects.toThrow()
    expect(h.env.E2E_SERVER_MODE).toBeUndefined()
    finishImageServer(h.io)
    expect(h.receipt('image-server-after.json').stopped).toBe(true)
    expect(h.writes.has('image-server-ready.json')).toBe(false)
  })

  it.each([
    'receipt-id',
    'receipt-run',
    'receipt-attempt',
    'receipt-shard',
    'receipt-source',
    'receipt-hash',
    'receipt-mode',
    'env-id',
    'env-image',
    'env-mode',
    'label',
    'container-id',
    'container-env',
  ])('never reads logs or stops a target with %s drift', async (fault) => {
    const h = makeHarness()
    await startImageServer(IMAGE, h.io)
    const own = h.receipt('image-server-owned.json')
    if (fault === 'receipt-id') own.container_id = 'e'.repeat(64)
    if (fault === 'receipt-run') own.run_id = 999
    if (fault === 'receipt-attempt') own.run_attempt = 9
    if (fault === 'receipt-shard') own.shard = 8
    if (fault === 'receipt-source') own.commit = '9'.repeat(40)
    if (fault === 'receipt-hash')
      own.fixture_receipt = 'DESIGN_FIXTURE_ENVIRONMENT_OK:' + '0'.repeat(64)
    if (fault === 'receipt-mode') own.mode = 'test'
    if (fault === 'env-id') h.env.DESIGN_FIXTURE_APP_ID = 'e'.repeat(64)
    if (fault === 'env-image') h.env.DESIGN_FIXTURE_APP_IMAGE = 'sha256:' + 'e'.repeat(64)
    if (fault === 'env-mode') h.env.DESIGN_FIXTURE_APP_MODE = 'test'
    if (fault === 'label') h.container.Config.Labels['systems.venturi.e2e.attempt'] = '1'
    if (fault === 'container-id') h.container.Id = 'e'.repeat(64)
    if (fault === 'container-env')
      h.container.Config.Env.push('PRIVATE_VALUE=private-cleanup-value')
    h.writes.set('image-server-owned.json', JSON.stringify(own))
    expect(() => finishImageServer(h.io)).toThrow()
    expect(h.dockerOperations().some(([op]) => ['logs', 'stop'].includes(op))).toBe(false)
    expect(h.writes.has('image-server-after.json')).toBe(false)
  })

  it.each(['log-command', 'log-write', 'stop', 'already-exited', 'stays-running'])(
    'retains failure evidence and attempts owned cleanup for %s',
    async (fault) => {
      const h = makeHarness()
      await startImageServer(IMAGE, h.io)
      const originalCommand = h.io.command
      h.io.command = vi.fn((name, args) => {
        const op = args[2]
        if (
          name === 'docker' &&
          ((fault === 'log-command' && op === 'logs') || (fault === 'stop' && op === 'stop'))
        ) {
          throw new Error('private-child-output')
        }
        if (name === 'docker' && fault === 'stays-running' && op === 'stop') return APP
        return originalCommand(name, args)
      })
      if (fault === 'log-write')
        vi.mocked(h.io.writeLog).mockImplementation(() => {
          throw new Error('disk')
        })
      if (fault === 'already-exited') h.container.State = { Running: false, Status: 'exited' }
      expect(() => finishImageServer(h.io)).toThrow('E2E compiled fixture validation failed')
      const operations = vi.mocked(h.io.command).mock.calls.filter(([name]) => name === 'docker')
      if (fault !== 'already-exited')
        expect(operations.some(([, args]) => args[2] === 'stop')).toBe(true)
      const after = h.receipt('image-server-after.json')
      expect(after.configuration_verified).toBe(true)
      expect(after.stopped).toBe(!['stop', 'stays-running'].includes(fault))
      expect(after.problems).not.toEqual([])
      expect(JSON.stringify(after)).not.toContain('private-child-output')
    }
  )

  it('does not discover or stop containers when startup never recorded an owned ID', () => {
    const h = makeHarness()
    finishImageServer(h.io)
    expect(h.dockerOperations()).toEqual([])
    expect(h.receipt('image-server-after.json')).toEqual({
      schema: 1,
      attempted: false,
      created: null,
      creation_confirmed: false,
      stopped: false,
      problems: [],
    })
  })
  it.each(['changed-head', 'dirty-tree', 'git-failure'])(
    'still cleans up the owned app after %s, retaining failed source evidence',
    async (fault) => {
      const h = makeHarness()
      await startImageServer(IMAGE, h.io)
      const original = h.io.command
      h.io.command = vi.fn((name, args) => {
        if (name === 'git') {
          if (fault === 'git-failure' || (fault === 'dirty-tree' && args[0] === 'diff'))
            throw new Error('git')
          if (fault === 'changed-head' && args.join(' ') === 'rev-parse HEAD') return '9'.repeat(40)
        }
        return original(name, args)
      })
      expect(() => finishImageServer(h.io)).toThrow('source-changed-or-unavailable')
      expect(h.receipt('image-server-after.json')).toMatchObject({
        stopped: true,
        source_unchanged: false,
        configuration_verified: true,
      })
      expect(h.dockerOperations().filter(([op]) => op === 'stop')).toEqual([
        ['stop', '--time', '10', APP],
      ])
    }
  )

  it.each(['create-stdout-lost', 'owned-write-failed'])(
    'recovers only the captured CID after %s',
    async (fault) => {
      const h = makeHarness()
      const originalCommand = h.io.command
      const originalWrite = h.io.write
      h.io.command = vi.fn((name, args) => {
        const result = originalCommand(name, args)
        if (fault === 'create-stdout-lost' && name === 'docker' && args[2] === 'create')
          throw new Error('lost stdout')
        return result
      })
      h.io.write = vi.fn((name, value) => {
        if (fault === 'owned-write-failed' && name === 'image-server-owned.json')
          throw new Error('disk')
        originalWrite(name, value)
      })
      await expect(startImageServer(IMAGE, h.io)).rejects.toThrow()
      expect(h.writes.has('image-server-owned.json')).toBe(false)
      expect(h.writes.get('image-server.cid')?.trim()).toBe(APP)
      // Docker created but the start never occurred; retain that distinction.
      expect(() => finishImageServer(h.io)).toThrow('app-exited-before-cleanup')
      expect(h.receipt('image-server-after.json')).toMatchObject({
        created: true,
        creation_confirmed: true,
        recovered_from_cid: true,
        container_id: APP,
        running_before_stop: false,
        stopped: true,
      })
      expect(h.dockerOperations().some(([op]) => ['start', 'stop', 'rm'].includes(op))).toBe(false)
    }
  )

  it('does not claim absence or discover a container when create has no CID receipt', async () => {
    const h = makeHarness()
    const original = h.io.command
    h.io.command = vi.fn((name, args) => {
      if (name === 'docker' && args[2] === 'create') throw new Error('creation uncertain')
      return original(name, args)
    })
    await expect(startImageServer(IMAGE, h.io)).rejects.toThrow()
    const calls = h.dockerOperations().length
    expect(() => finishImageServer(h.io)).toThrow('creation-unconfirmed')
    expect(h.dockerOperations()).toHaveLength(calls)
    expect(h.receipt('image-server-after.json')).toMatchObject({
      attempted: true,
      created: null,
      creation_confirmed: false,
      stopped: false,
    })
  })

  it.each(['attempt-run', 'attempt-service', 'attempt-source', 'cid-mismatch', 'missing-attempt'])(
    'refuses cleanup with %s retained-identity drift',
    async (fault) => {
      const h = makeHarness()
      await startImageServer(IMAGE, h.io)
      const attempt = h.receipt('image-server-attempt.json')
      if (fault === 'attempt-run') attempt.run_id = 999
      if (fault === 'attempt-service') attempt.service_receipt = 'foreign'
      if (fault === 'attempt-source') attempt.commit = '9'.repeat(40)
      h.writes.set('image-server-attempt.json', JSON.stringify(attempt))
      if (fault === 'missing-attempt') h.writes.delete('image-server-attempt.json')
      if (fault === 'cid-mismatch') h.writes.set('image-server.cid', 'e'.repeat(64))
      expect(() => finishImageServer(h.io)).toThrow()
      expect(h.dockerOperations().some(([op]) => ['logs', 'stop'].includes(op))).toBe(false)
    }
  )

  it.each([
    'pid',
    'started-at',
    'restart-count',
    'invalid-pid',
    'invalid-start',
    'invalid-calendar',
    'invalid-restarts',
  ])('refuses ready evidence after %s process-identity drift', async (fault) => {
    const h = makeHarness()
    vi.mocked(h.io.verifyDevelopmentMode).mockImplementation(async () => {
      if (fault === 'pid') h.container.State.Pid = 1235
      if (fault === 'started-at') h.container.State.StartedAt = '2026-10-03T00:00:01Z'
      if (fault === 'restart-count') h.container.RestartCount = 1
      if (fault === 'invalid-pid') h.container.State.Pid = 0
      if (fault === 'invalid-start') h.container.State.StartedAt = '0001-01-01T00:00:00Z'
      if (fault === 'invalid-calendar') h.container.State.StartedAt = '2026-02-30T00:00:00Z'
      if (fault === 'invalid-restarts') h.container.RestartCount = -1
      return { requests: 4, elapsed_ms: 25, origin_rejected: true }
    })
    await expect(startImageServer(IMAGE, h.io)).rejects.toThrow()
    expect(h.io.exportEnvironment).not.toHaveBeenCalled()
    expect(h.writes.has('image-server-ready.json')).toBe(false)
  })
})

describe('compiled development authentication discriminator', () => {
  const validation = () =>
    new Response(
      JSON.stringify({
        code: 'VALIDATION_ERROR',
        message: '[body.email]: Invalid input: expected string',
      }),
      { status: 400 }
    )
  const origin = () =>
    new Response(
      JSON.stringify({
        code: 'INVALID_CALLBACK_URL',
        message: 'Invalid callback URL',
      }),
      { status: 403 }
    )
  const good = () => {
    let count = 0
    return vi.fn(async () => (++count <= 4 ? validation() : origin()))
  }

  it('uses five bounded same-path requests with no email, redirects or forwarded identity', async () => {
    const request = good()
    let clock = 0
    const result = await verifyCompiledDevelopmentMode(request as typeof fetch, () => clock++)
    expect(result).toMatchObject({ requests: 4, origin_rejected: true })
    expect(result.elapsed_ms).toBeGreaterThan(0)
    expect(request).toHaveBeenCalledTimes(5)
    for (const [index, call] of request.mock.calls.entries()) {
      const [url, options] = call as unknown as [string, RequestInit]
      expect(url).toBe(OTP)
      expect(options).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Origin: URL },
      })
      expect(options.signal).toBeInstanceOf(AbortSignal)
      const body = JSON.parse(String(options.body))
      expect(body).toEqual(
        index < 4
          ? { type: 'sign-in' }
          : { type: 'sign-in', callbackURL: 'https://rejected.acme.example' }
      )
      expect(body).not.toHaveProperty('email')
      expect(Object.keys(options.headers!)).toEqual(['Content-Type', 'Origin'])
    }
  })

  it.each([
    'limiter',
    'wrong-status',
    'wrong-code',
    'wrong-field',
    'redirect',
    'parse-error',
    'transport',
    'origin-status',
    'origin-code',
    'origin-redirect',
  ])('rejects %s without retry or disclosing response/transport contents', async (fault) => {
    let count = 0
    const request = vi.fn(async () => {
      count++
      const target = fault.startsWith('origin-') ? 5 : 4
      if (count !== target) return count <= 4 ? validation() : origin()
      if (fault === 'transport') throw new Error('private-transport-content')
      if (fault === 'parse-error') return new Response('private-response-content', { status: 400 })
      const response = new Response(
        JSON.stringify({
          code: ['wrong-code', 'origin-code'].includes(fault)
            ? 'private-response-code'
            : fault.startsWith('origin-')
              ? 'INVALID_CALLBACK_URL'
              : 'VALIDATION_ERROR',
          message:
            fault === 'wrong-field' ? '[body.type]: private-response-content' : '[body.email]',
        }),
        {
          status:
            fault === 'limiter'
              ? 429
              : fault === 'wrong-status'
                ? 200
                : fault === 'origin-status'
                  ? 400
                  : fault.startsWith('origin-')
                    ? 403
                    : 400,
        }
      )
      if (fault === 'redirect' || fault === 'origin-redirect')
        Object.defineProperty(response, 'redirected', { value: true })
      return response
    })
    let failure: unknown
    try {
      await verifyCompiledDevelopmentMode(request as typeof fetch, () => 25)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ImageServerProbeError)
    const proof = failure as ImageServerProbeError
    expect(proof.receipt.request_index).toBe(fault.startsWith('origin-') ? 5 : 4)
    expect(proof.receipt.elapsed_ms).toBe(0)
    expect(request).toHaveBeenCalledTimes(fault.startsWith('origin-') ? 5 : 4)
    expect(String(proof)).not.toContain('private-')
    expect(JSON.stringify(proof)).not.toContain('private-')
    expect(proof.cause).toBeUndefined()
  })

  it.each([60_000, 60_001, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects an ambiguous elapsed window %s before a request can proceed',
    async (elapsed) => {
      let count = 0
      const now = () => (count++ === 0 ? 0 : elapsed)
      const request = good()
      await expect(
        verifyCompiledDevelopmentMode(request as typeof fetch, now)
      ).rejects.toMatchObject({ receipt: { reason: 'window' } })
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('rejects slow body delivery that crosses the limiter window', async () => {
    let clock = 0
    const request = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ code: 'VALIDATION_ERROR', message: '[body.email]' })
              )
            )
            controller.close()
            clock = 60_000
          },
        }),
        { status: 400 }
      )
    })
    await expect(
      verifyCompiledDevelopmentMode(request as typeof fetch, () => clock)
    ).rejects.toMatchObject({ receipt: { reason: 'window', request_index: 1 } })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not accept test-mode origin bypass after the four validation controls passed', async () => {
    const request = vi.fn(async () => validation())
    await expect(
      verifyCompiledDevelopmentMode(request as typeof fetch, () => 0)
    ).rejects.toMatchObject({ receipt: { reason: 'origin', request_index: 5, status: 400 } })
    expect(request).toHaveBeenCalledTimes(5)
  })
  it.each(['oversized-single', 'oversized-chunks', 'invalid-utf8'])(
    'bounds and cancels %s response bodies',
    async (fault) => {
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (fault === 'invalid-utf8') {
            controller.enqueue(new Uint8Array([255]))
            controller.close()
          } else if (fault === 'oversized-single') controller.enqueue(new Uint8Array(4097))
          else {
            controller.enqueue(new Uint8Array(3000))
            controller.enqueue(new Uint8Array(1097))
          }
        },
        cancel,
      })
      const request = vi.fn(async () => new Response(stream, { status: 400 }))
      await expect(verifyCompiledDevelopmentMode(request as typeof fetch)).rejects.toMatchObject({
        receipt: { reason: 'response', request_index: 1 },
      })
      expect(request).toHaveBeenCalledTimes(1)
      if (fault !== 'invalid-utf8') expect(cancel).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['headers', 'body'])('has one five-second deadline for stalled %s', async (phase) => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn()
      const request = vi.fn((_url: string | URL | Request, _options?: RequestInit) =>
        phase === 'headers'
          ? new Promise<Response>(() => {})
          : Promise.resolve(new Response(new ReadableStream({ cancel }), { status: 400 }))
      )
      const result = verifyCompiledDevelopmentMode(request as typeof fetch)
      const assertion = expect(result).rejects.toMatchObject({
        receipt: { reason: phase === 'headers' ? 'request' : 'response', request_index: 1 },
      })
      await vi.advanceTimersByTimeAsync(5000)
      await assertion
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true)
      if (phase === 'body') expect(cancel).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('explicit Playwright image-server selection', () => {
  afterEach(() => {
    vi.doUnmock('../apps/web/e2e/utils/design-fixture-guard')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function loadConfig(env: NodeJS.ProcessEnv, appFailure = false) {
    const original = process.env
    process.env = { ...env }
    const order: string[] = []
    vi.resetModules()
    vi.doMock('../apps/web/e2e/utils/design-fixture-guard', () => ({
      assertDesignFixtureEnvironmentSync: () => {
        order.push('services')
        validateDesignFixtureEnvironment(process.env)
      },
      assertDesignFixtureImageServerSync: () => {
        order.push('image')
        if (appFailure) throw new Error('app inspection failed')
      },
    }))
    try {
      const mod = await import('../apps/web/playwright.config')
      return { config: mod.default, order }
    } finally {
      process.env = original
    }
  }

  const imageEnv = () => ({
    ...fixture(),
    E2E_SERVER_MODE: 'image',
    DESIGN_FIXTURE_APP_MODE: 'development',
    DESIGN_FIXTURE_APP_ID: APP,
    DESIGN_FIXTURE_APP_IMAGE: IMAGE,
    DESIGN_FIXTURE_APP_REVISION: SOURCE,
    DESIGN_FIXTURE_SHARD: '3',
  })

  it('retains the default local dev launcher and readiness policy', async () => {
    const { config, order } = await loadConfig({})
    expect(order).toEqual([])
    expect(config.webServer).toMatchObject({
      command: 'bun e2e/scripts/dev-server.ts',
      url: URL,
      reuseExistingServer: true,
      timeout: 120_000,
    })
    expect(config.expect?.timeout).toBe(5000)
    expect(config.timeout).toBe(30_000)
  })

  it('removes webServer only after both guards pass and keeps CI test semantics', async () => {
    const { config, order } = await loadConfig(imageEnv())
    expect(order).toEqual(['services', 'image'])
    expect(config.webServer).toBeUndefined()
    expect(config.retries).toBe(2)
    expect(config.workers).toBe(1)
    expect(config.globalTimeout).toBe(45 * 60 * 1000)
  })

  it.each(['unknown', 'missing-mode', 'partial', 'local-partial', 'test-mode', 'app-failed'])(
    'refuses %s image selection without falling back to a dev server',
    async (fault) => {
      const env: NodeJS.ProcessEnv = imageEnv()
      if (fault === 'unknown') env.E2E_SERVER_MODE = 'other'
      if (fault === 'missing-mode') {
        for (const name of Object.keys(env))
          if (
            name.startsWith('DESIGN_FIXTURE_APP_') ||
            name === 'E2E_SERVER_MODE' ||
            name === 'DESIGN_FIXTURE_SHARD'
          )
            delete env[name]
      }
      if (fault === 'partial') delete env.DESIGN_FIXTURE_APP_ID
      if (fault === 'local-partial') {
        delete env.CI
        delete env.E2E_SERVER_MODE
      }
      if (fault === 'test-mode') env.DESIGN_FIXTURE_APP_MODE = 'test'
      await expect(loadConfig(env, fault === 'app-failed')).rejects.toThrow()
    }
  )
})
