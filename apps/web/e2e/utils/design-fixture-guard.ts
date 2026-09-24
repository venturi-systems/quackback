/**
 * Validate the disposable CI fixture before migrations, app startup or setup.
 * Job service IDs come from GitHub's service context, not an ownership claim
 * derived from a loopback URL. This module imports no application or DB code.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_PATH = fileURLToPath(import.meta.url)
const WEB_ROOT = resolve(dirname(GUARD_PATH), '../..')
const RECEIPT = 'DESIGN_FIXTURE_ENVIRONMENT_OK'
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
    env.VENTURI_TEAM_EMAIL_DOMAINS !== 'example.com'
  )
    fail()
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
    'SMTP_HOST',
    'SMTP_URL',
    'RESEND_API_KEY',
    'OPENAI_API_KEY',
  ]) {
    if (env[name]) fail()
  }
}

function run(command: string, args: string[], cwd = WEB_ROOT): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    })
  } catch {
    // Never attach child stderr or environment values to a durable report.
    throw new Error(FAILURE)
  }
}

function validateJobServices(): void {
  const ids = [process.env.DESIGN_FIXTURE_POSTGRES_ID!, process.env.DESIGN_FIXTURE_REDIS_ID!]
  type Service = {
    Id: string
    State: { Running: boolean }
    HostConfig: { NetworkMode: string }
    Mounts: Array<{ Type: string }>
    NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }> | null> }
  }
  let services: Service[]
  try {
    services = JSON.parse(run('docker', ['inspect', ...ids]))
  } catch {
    throw new Error(FAILURE)
  }
  if (services.length !== 2) throw new Error(FAILURE)
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
}

/** Used by config and the workflow before any fixture/app code executes. */
export function assertDesignFixtureEnvironmentSync(baseURL?: string): void {
  // These outer checks run before spawning any loader.
  validateDesignFixtureEnvironment(process.env, baseURL)
  validateJobServices()
  // Helpers, dev server, and migration each load the generated fixture env.
  // Execute only this pure validator through each loader; never import migrate.
  const commands: Array<[string, string[], string]> = [
    ['dotenv', ['-e', '../../.env', '--', 'bun', GUARD_PATH, '--effective-environment'], WEB_ROOT],
    ['bun', ['--env-file=../../.env', GUARD_PATH, '--effective-environment'], WEB_ROOT],
    [
      'bun',
      [
        '--eval',
        "import { config } from 'dotenv'; config({path:'../../.env',quiet:true}); const { validateDesignFixtureEnvironment } = await import(" +
          JSON.stringify(GUARD_PATH) +
          '); validateDesignFixtureEnvironment(process.env); process.stdout.write(' +
          JSON.stringify(RECEIPT) +
          ')',
      ],
      resolve(WEB_ROOT, '../../packages/db'),
    ],
  ]
  for (const [command, args, cwd] of commands) {
    if (run(command, args, cwd) !== RECEIPT) throw new Error(FAILURE)
  }
}

export async function assertDesignFixtureEnvironment(baseURL?: string): Promise<void> {
  assertDesignFixtureEnvironmentSync(baseURL)
}

if (process.argv[1] === GUARD_PATH) {
  if (process.argv[2] === '--effective-environment') {
    validateDesignFixtureEnvironment(process.env)
    process.stdout.write(RECEIPT)
  } else if (process.argv[2] === '--preflight') {
    assertDesignFixtureEnvironmentSync()
    process.stdout.write(RECEIPT + '\n')
  } else {
    throw new Error(FAILURE)
  }
}
