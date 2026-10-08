/**
 * Validate the disposable CI fixture before migrations, app startup or setup.
 * Job service IDs come from GitHub's service context, not an ownership claim
 * derived from a loopback URL. This module imports no application or DB code.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_PATH = fileURLToPath(import.meta.url)
const WEB_ROOT = resolve(dirname(GUARD_PATH), '../..')
const RECEIPT = 'DESIGN_FIXTURE_ENVIRONMENT_OK'
export const LOCAL_DOCKER_ENDPOINT = 'unix:///var/run/docker.sock'
const FAILURE = 'Design acceptance requires the isolated GitHub CI fixture'

export function validateDesignFixtureEnvironment(
  env: NodeJS.ProcessEnv,
  baseURL = 'http://acme.localhost:3000'
): void {
  const fail = (): never => {
    throw new Error(FAILURE)
  }
  const parse = (value: string | undefined) => {
    try {
      return new URL(value ?? '')
    } catch {
      return fail()
    }
  }
  if (
    env.CI !== 'true' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'venturi-systems/quackback' ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !/^[a-f0-9]{64}$/.test(env.DESIGN_FIXTURE_POSTGRES_ID ?? '') ||
    !/^[a-f0-9]{64}$/.test(env.DESIGN_FIXTURE_REDIS_ID ?? '') ||
    env.DESIGN_FIXTURE_POSTGRES_ID === env.DESIGN_FIXTURE_REDIS_ID ||
    env.NODE_ENV === 'production'
  )
    fail()
  const target = parse(baseURL)
  if (target.href !== 'http://acme.localhost:3000/') fail()
  const database = parse(env.DATABASE_URL)
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    database.hostname !== 'localhost' ||
    database.port !== '5432' ||
    database.pathname !== '/quackback_test' ||
    database.username !== 'postgres' ||
    database.password !== 'password' ||
    database.search ||
    database.hash
  )
    fail()
  if (
    env.REDIS_URL !== 'redis://localhost:6379' ||
    env.BASE_URL !== 'http://localhost:3000' ||
    env.TRUSTED_ORIGINS !== 'http://acme.localhost:3000' ||
    env.SECRET_KEY !== 'test-secret-for-ci-only-must-be-at-least-32-characters' ||
    env.BETTER_AUTH_SECRET !== env.SECRET_KEY ||
    env.VENTURI_TEAM_EMAIL_DOMAINS !== 'example.com,acme.example'
  )
    fail()
  const mailpitRequested =
    env.DESIGN_FIXTURE_MAILPIT_ID !== undefined ||
    env.DESIGN_FIXTURE_MAILPIT_IMAGE !== undefined ||
    env.DESIGN_FIXTURE_MAILPIT_NETWORK !== undefined
  const captureEmail: Record<string, string> = {
    EMAIL_SMTP_HOST: '127.0.0.1',
    EMAIL_SMTP_PORT: '1025',
    EMAIL_SMTP_SECURE: 'false',
    EMAIL_FROM: 'Avery Stone <avery.stone@acme.example>',
  }
  if (mailpitRequested) {
    if (
      !/^[a-f0-9]{64}$/.test(env.DESIGN_FIXTURE_MAILPIT_ID ?? '') ||
      [env.DESIGN_FIXTURE_POSTGRES_ID, env.DESIGN_FIXTURE_REDIS_ID].includes(
        env.DESIGN_FIXTURE_MAILPIT_ID
      ) ||
      !/^axllent\/mailpit@sha256:[a-f0-9]{64}$/.test(env.DESIGN_FIXTURE_MAILPIT_IMAGE ?? '') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(env.DESIGN_FIXTURE_MAILPIT_NETWORK ?? '') ||
      ['host', 'bridge', 'default', 'none'].includes(env.DESIGN_FIXTURE_MAILPIT_NETWORK ?? '') ||
      Object.entries(captureEmail).some(([name, value]) => env[name] !== value)
    ) {
      fail()
    }
  }
  // The email package consumes EMAIL_* names. Unconfigured fixtures must not
  // inherit a real provider; capture fixtures allow only these four exact values.
  for (const name of Object.keys(env)) {
    if (name.startsWith('EMAIL_') && (!mailpitRequested || !(name in captureEmail))) fail()
  }
  const imageKeys = [
    'E2E_SERVER_MODE',
    'DESIGN_FIXTURE_APP_ID',
    'DESIGN_FIXTURE_APP_IMAGE',
    'DESIGN_FIXTURE_APP_REVISION',
    'DESIGN_FIXTURE_APP_MODE',
    'DESIGN_FIXTURE_SHARD',
  ]
  if (imageKeys.some((name) => env[name] !== undefined)) {
    if (
      env.E2E_SERVER_MODE !== 'image' ||
      env.DESIGN_FIXTURE_APP_MODE !== 'development' ||
      !mailpitRequested ||
      !/^[a-f0-9]{64}$/.test(env.DESIGN_FIXTURE_APP_ID ?? '') ||
      [
        env.DESIGN_FIXTURE_POSTGRES_ID,
        env.DESIGN_FIXTURE_REDIS_ID,
        env.DESIGN_FIXTURE_MAILPIT_ID,
      ].includes(env.DESIGN_FIXTURE_APP_ID) ||
      !/^sha256:[a-f0-9]{64}$/.test(env.DESIGN_FIXTURE_APP_IMAGE ?? '') ||
      !/^[a-f0-9]{40}$/.test(env.DESIGN_FIXTURE_APP_REVISION ?? '') ||
      !/^[1-8]$/.test(env.DESIGN_FIXTURE_SHARD ?? '')
    )
      fail()
  }
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'SMTP_HOST',
    'SMTP_URL',
    'RESEND_API_KEY',
    'OPENAI_API_KEY',
  ]) {
    if (env[name]) fail()
  }
}

/** Bind effective loaders to the already-inspected job identity without exposing secrets. */
export function designFixtureEnvironmentReceipt(env: NodeJS.ProcessEnv): string {
  validateDesignFixtureEnvironment(env)
  const identity = [
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT,
    env.DESIGN_FIXTURE_POSTGRES_ID,
    env.DESIGN_FIXTURE_REDIS_ID,
    env.DESIGN_FIXTURE_MAILPIT_ID ?? null,
    env.DESIGN_FIXTURE_MAILPIT_IMAGE ?? null,
    env.DESIGN_FIXTURE_MAILPIT_NETWORK ?? null,
    env.E2E_SERVER_MODE ?? null,
    env.DESIGN_FIXTURE_APP_ID ?? null,
    env.DESIGN_FIXTURE_APP_IMAGE ?? null,
    env.DESIGN_FIXTURE_APP_REVISION ?? null,
    env.DESIGN_FIXTURE_APP_MODE ?? null,
    env.DESIGN_FIXTURE_SHARD ?? null,
  ]
  return RECEIPT + ':' + createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function run(
  command: string,
  args: string[],
  cwd = WEB_ROOT,
  stage = 'service-inspection'
): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    })
  } catch (error) {
    // Fixed stage and allowlisted process metadata only; never child stderr or environment.
    const failure = error as { code?: unknown; status?: unknown }
    const code = ['ENOENT', 'EACCES', 'ETIMEDOUT'].includes(String(failure.code))
      ? String(failure.code)
      : 'CHILD_FAILED'
    const status = typeof failure.status === 'number' ? failure.status : 'unknown'
    // Child errors retain stderr/environment; preserve only the sanitized diagnostic cause.
    // eslint-disable-next-line preserve-caught-error -- never retain credential-bearing child output
    throw new Error(`${FAILURE}: ${stage}`, { cause: new Error(`${code}; status=${status}`) })
  }
}

function validateJobServices(): void {
  const mailpitId = process.env.DESIGN_FIXTURE_MAILPIT_ID
  const ids = [process.env.DESIGN_FIXTURE_POSTGRES_ID!, process.env.DESIGN_FIXTURE_REDIS_ID!]
  if (mailpitId) ids.push(mailpitId)
  type PublishedPorts = Record<string, Array<{ HostPort: string; HostIp?: string }> | null>
  type Service = {
    Id: string
    Image?: string
    State: { Running: boolean; Health?: { Status: string } }
    HostConfig: { NetworkMode: string; PortBindings?: PublishedPorts }
    Mounts: Array<{ Type: string }>
    NetworkSettings: {
      Ports: PublishedPorts
      Networks?: Record<string, { NetworkID: string }>
    }
    Config?: {
      Image?: string
      Entrypoint?: string[] | null
      Cmd?: string[] | null
      Env?: string[]
      Healthcheck?: { Test?: string[] }
    }
  }
  const onlyCapturePort = (ports: PublishedPorts | undefined): boolean => {
    const bindings = ports?.['1025/tcp']
    return (
      bindings?.length === 1 &&
      bindings[0].HostIp === '127.0.0.1' &&
      bindings[0].HostPort === '1025' &&
      Object.entries(ports ?? {}).every(
        ([port, published]) => port === '1025/tcp' || (published?.length ?? 0) === 0
      )
    )
  }
  let services: Service[]
  try {
    services = JSON.parse(run('docker', ['--host', LOCAL_DOCKER_ENDPOINT, 'inspect', ...ids]))
  } catch {
    throw new Error(FAILURE)
  }
  if (services.length !== ids.length) throw new Error(FAILURE)
  for (const [index, port] of ['5432', '6379'].entries()) {
    const service = services[index]
    if (
      service.Id !== ids[index] ||
      !service.State.Running ||
      service.HostConfig.NetworkMode === 'host' ||
      service.Mounts.some((mount) => mount.Type === 'bind') ||
      !service.NetworkSettings.Ports[port + '/tcp']?.some((binding) => binding.HostPort === port)
    ) {
      throw new Error(FAILURE)
    }
  }
  if (mailpitId) {
    const service = services[2]
    const network = process.env.DESIGN_FIXTURE_MAILPIT_NETWORK!
    const networkId = services[0].NetworkSettings.Networks?.[network]?.NetworkID
    const imageId = service.Image
    if (
      service.Id !== mailpitId ||
      !service.State.Running ||
      service.State.Health?.Status !== 'healthy' ||
      JSON.stringify(service.Config?.Healthcheck?.Test) !==
        JSON.stringify(['CMD', '/mailpit', 'readyz']) ||
      typeof imageId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
      !network ||
      ['host', 'bridge', 'default', 'none'].includes(network) ||
      !/^[a-f0-9]{64}$/.test(networkId ?? '') ||
      services.some((entry) => {
        const memberships = entry.NetworkSettings.Networks ?? {}
        return (
          entry.HostConfig.NetworkMode !== network ||
          Object.keys(memberships).length !== 1 ||
          Object.keys(memberships)[0] !== network ||
          memberships[network]?.NetworkID !== networkId
        )
      }) ||
      service.Mounts.length !== 0 ||
      service.Config?.Image !== process.env.DESIGN_FIXTURE_MAILPIT_IMAGE ||
      JSON.stringify(service.Config?.Entrypoint) !== JSON.stringify(['/mailpit']) ||
      (service.Config?.Cmd?.length ?? 0) !== 0 ||
      !Array.isArray(service.Config?.Env) ||
      service.Config.Env.some((entry) => /^(MP_|MAILPIT_|SMTP_|EMAIL_|RESEND_)/.test(entry)) ||
      !onlyCapturePort(service.HostConfig.PortBindings) ||
      !onlyCapturePort(service.NetworkSettings.Ports)
    ) {
      throw new Error(FAILURE)
    }
    // The publisher pin identifies an OCI index; the running container records
    // its platform image config ID. Bind both through local image metadata.
    let images: Array<{ Id: string; RepoDigests?: string[] }>
    try {
      images = JSON.parse(
        run('docker', ['--host', LOCAL_DOCKER_ENDPOINT, 'image', 'inspect', imageId])
      )
    } catch {
      throw new Error(FAILURE)
    }
    if (
      !Array.isArray(images) ||
      images.length !== 1 ||
      images[0]?.Id !== imageId ||
      !Array.isArray(images[0].RepoDigests) ||
      !images[0].RepoDigests.includes(process.env.DESIGN_FIXTURE_MAILPIT_IMAGE!)
    ) {
      throw new Error(FAILURE)
    }
  }
}

export interface FixtureAppImage {
  Id: string
  Config: {
    Labels: Record<string, string>
    Env: string[]
    Entrypoint: string[]
    Cmd?: string[] | null
    WorkingDir: string
    User: string
  }
}

export interface FixtureAppContainer {
  Id: string
  Image: string
  State: { Running: boolean; Status: string; Pid?: number; StartedAt?: string }
  RestartCount?: number
  Config: FixtureAppImage['Config'] & { Image: string }
  HostConfig: {
    NetworkMode: string
    Privileged: boolean
    AutoRemove: boolean
    CapAdd?: string[] | null
    Devices?: unknown[] | null
    PortBindings?: Record<string, unknown> | null
  }
  Mounts: unknown[]
}

/** Docker's effective values, without dotenv fallback or duplicate-key ambiguity. */
function dockerEnvironment(entries: string[]): Record<string, string> {
  if (!Array.isArray(entries)) throw new Error(FAILURE)
  const values: Record<string, string> = Object.create(null)
  for (const entry of entries) {
    const equal = typeof entry === 'string' ? entry.indexOf('=') : -1
    if (equal <= 0) throw new Error(FAILURE)
    const name = entry.slice(0, equal)
    if (!/^[A-Z_a-z][A-Z_a-z0-9]*$/.test(name) || Object.hasOwn(values, name))
      throw new Error(FAILURE)
    values[name] = entry.slice(equal + 1)
  }
  return values
}

/** Pass only declared fixture values to the app, never the runner's full environment. */
export function fixtureAppEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  validateDesignFixtureEnvironment(env)
  if (!env.DESIGN_FIXTURE_MAILPIT_ID) throw new Error(FAILURE)
  const values: Record<string, string> = {
    NODE_ENV: 'development',
    PORT: '3000',
    HOSTNAME: '127.0.0.1',
    NITRO_HOST: '127.0.0.1',
    SKIP_MIGRATIONS: 'true',
    SEED_DATABASE: 'false',
    DISABLE_TELEMETRY: 'true',
  }
  for (const name of [
    'DATABASE_URL',
    'REDIS_URL',
    'BASE_URL',
    'TRUSTED_ORIGINS',
    'SECRET_KEY',
    'BETTER_AUTH_SECRET',
    'VENTURI_TEAM_EMAIL_DOMAINS',
    'EMAIL_SMTP_HOST',
    'EMAIL_SMTP_PORT',
    'EMAIL_SMTP_SECURE',
    'EMAIL_FROM',
  ]) {
    if (typeof env[name] !== 'string' || !env[name]) throw new Error(FAILURE)
    values[name] = env[name]!
  }
  return values
}

export function fixtureAppLabels(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    'systems.venturi.e2e.run': env.GITHUB_RUN_ID!,
    'systems.venturi.e2e.attempt': env.GITHUB_RUN_ATTEMPT!,
    'systems.venturi.e2e.shard': env.DESIGN_FIXTURE_SHARD!,
    'systems.venturi.e2e.mode': 'development',
    'systems.venturi.e2e.postgres': env.DESIGN_FIXTURE_POSTGRES_ID!,
    'systems.venturi.e2e.redis': env.DESIGN_FIXTURE_REDIS_ID!,
    'systems.venturi.e2e.mailpit': env.DESIGN_FIXTURE_MAILPIT_ID!,
  }
}

export function validateFixtureAppImage(
  image: FixtureAppImage,
  imageId: string,
  revision: string
): void {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    image?.Id !== imageId ||
    image.Config?.Labels?.['org.opencontainers.image.source'] !==
      'https://github.com/venturi-systems/quackback' ||
    image.Config.Labels['org.opencontainers.image.revision'] !== revision ||
    JSON.stringify(image.Config.Entrypoint) !== JSON.stringify(['./docker-entrypoint.sh']) ||
    (image.Config.Cmd != null &&
      (!Array.isArray(image.Config.Cmd) || image.Config.Cmd.length !== 0)) ||
    image.Config.WorkingDir !== '/app' ||
    image.Config.User !== 'quackback'
  )
    throw new Error(FAILURE)
  const defaults = dockerEnvironment(image.Config.Env)
  // oven/bun:1.4.2-alpine sets PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH and
  // BUN_INSTALL_BIN (measured with `docker buildx imagetools inspect` on
  // 2026-10-08); apps/web/Dockerfile adds the rest.
  const allowedDefaults = new Set([
    'PATH',
    'HOME',
    'BUN_VERSION',
    'BUN_INSTALL',
    'BUN_INSTALL_BIN',
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
    'BUN_INSTALL_CACHE_DIR',
    'MIGRATIONS_FOLDER',
    'NODE_ENV',
    'PORT',
    'HOSTNAME',
  ])
  if (
    defaults.NODE_ENV !== 'production' ||
    defaults.PORT !== '3000' ||
    defaults.HOSTNAME !== '0.0.0.0' ||
    Object.keys(defaults).some((name) => !allowedDefaults.has(name))
  )
    throw new Error(FAILURE)
}

/** Compiled development-mode acceptance; the separate production render lane remains unchanged. */
export function validateFixtureAppContainer(
  env: NodeJS.ProcessEnv,
  image: FixtureAppImage,
  container: FixtureAppContainer,
  revision: string,
  phase: 'created' | 'running' | 'retained'
): void {
  validateDesignFixtureEnvironment(env)
  if (env.E2E_SERVER_MODE !== 'image' || env.DESIGN_FIXTURE_APP_REVISION !== revision)
    throw new Error(FAILURE)
  validateFixtureAppImage(image, env.DESIGN_FIXTURE_APP_IMAGE!, revision)
  const expected = { ...dockerEnvironment(image.Config.Env), ...fixtureAppEnvironment(env) }
  const actual = dockerEnvironment(container.Config?.Env)
  const labels = fixtureAppLabels(env)
  if (
    container.Id !== env.DESIGN_FIXTURE_APP_ID ||
    container.Image !== image.Id ||
    container.Config.Image !== image.Id ||
    container.Config.WorkingDir !== image.Config.WorkingDir ||
    container.Config.User !== image.Config.User ||
    JSON.stringify(container.Config.Entrypoint) !== JSON.stringify(image.Config.Entrypoint) ||
    JSON.stringify(container.Config.Cmd ?? null) !== JSON.stringify(image.Config.Cmd ?? null) ||
    Object.entries(labels).some(([name, value]) => container.Config.Labels?.[name] !== value) ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([name, value]) => actual[name] !== value) ||
    container.HostConfig?.NetworkMode !== 'host' ||
    container.HostConfig.Privileged !== false ||
    container.HostConfig.AutoRemove !== false ||
    (container.HostConfig.CapAdd?.length ?? 0) !== 0 ||
    (container.HostConfig.Devices?.length ?? 0) !== 0 ||
    Object.keys(container.HostConfig.PortBindings ?? {}).length !== 0 ||
    !Array.isArray(container.Mounts) ||
    container.Mounts.length !== 0 ||
    typeof container.State?.Running !== 'boolean' ||
    (container.State.Running
      ? container.State.Status !== 'running'
      : !['created', 'exited', 'dead'].includes(container.State.Status)) ||
    (phase === 'created' && (container.State?.Running || container.State?.Status !== 'created')) ||
    (phase === 'running' && (!container.State?.Running || container.State?.Status !== 'running'))
  )
    throw new Error(FAILURE)
}

/** Browser/config gate only. DB restore remains possible after an app process exits. */
export function assertDesignFixtureImageServerSync(): void {
  validateDesignFixtureEnvironment(process.env)
  if (process.env.E2E_SERVER_MODE !== 'image') throw new Error(FAILURE)
  const revision = run('git', ['rev-parse', 'HEAD'], WEB_ROOT, 'app-source').trim()
  let containers: FixtureAppContainer[]
  let images: FixtureAppImage[]
  try {
    containers = JSON.parse(
      run('docker', [
        '--host',
        LOCAL_DOCKER_ENDPOINT,
        'inspect',
        process.env.DESIGN_FIXTURE_APP_ID!,
      ])
    )
    images = JSON.parse(
      run('docker', [
        '--host',
        LOCAL_DOCKER_ENDPOINT,
        'image',
        'inspect',
        process.env.DESIGN_FIXTURE_APP_IMAGE!,
      ])
    )
    if (
      !Array.isArray(containers) ||
      containers.length !== 1 ||
      !Array.isArray(images) ||
      images.length !== 1
    )
      throw new Error(FAILURE)
    validateFixtureAppContainer(process.env, images[0], containers[0], revision, 'running')
  } catch {
    throw new Error(FAILURE)
  }
}

/** Used by config and the workflow before any fixture/app code executes. */
export function assertDesignFixtureEnvironmentSync(baseURL?: string): void {
  // These outer checks run before spawning any loader.
  validateDesignFixtureEnvironment(process.env, baseURL)
  const expectedReceipt = designFixtureEnvironmentReceipt(process.env)
  validateJobServices()
  // Helpers, dev server, and migration each load the generated fixture env.
  // Execute only this pure validator through each loader; never import migrate.
  const commands: Array<[string, string[], string]> = [
    [
      'bun',
      [
        resolve(WEB_ROOT, '../../node_modules/dotenv-cli/cli.js'),
        '-e',
        '../../.env',
        '--',
        'bun',
        GUARD_PATH,
        '--effective-environment',
      ],
      WEB_ROOT,
    ],
    ['bun', ['--env-file=../../.env', GUARD_PATH, '--effective-environment'], WEB_ROOT],
    [
      'bun',
      [
        '--eval',
        "import { config } from 'dotenv'; config({path:'../../.env',quiet:true}); const { designFixtureEnvironmentReceipt } = await import(" +
          JSON.stringify(GUARD_PATH) +
          '); process.stdout.write(designFixtureEnvironmentReceipt(process.env))',
      ],
      resolve(WEB_ROOT, '../../packages/db'),
    ],
  ]
  for (const [index, [command, args, cwd]] of commands.entries()) {
    const stage = ['helper-environment', 'app-environment', 'migration-environment'][index]
    if (run(command, args, cwd, stage) !== expectedReceipt)
      throw new Error(`${FAILURE}: ${stage} receipt mismatch`)
  }
}

export async function assertDesignFixtureEnvironment(baseURL?: string): Promise<void> {
  assertDesignFixtureEnvironmentSync(baseURL)
}

if (process.argv[1] === GUARD_PATH) {
  if (process.argv[2] === '--effective-environment') {
    process.stdout.write(designFixtureEnvironmentReceipt(process.env))
  } else if (process.argv[2] === '--preflight') {
    assertDesignFixtureEnvironmentSync()
    process.stdout.write(RECEIPT + '\n')
  } else {
    throw new Error(FAILURE)
  }
}
