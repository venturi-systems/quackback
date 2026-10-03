/** Own three auth settings only for the guarded, disposable acceptance fixture. */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDesignFixtureEnvironmentSync } from '../utils/design-fixture-guard'

type Scope = { runId: string; runAttempt: string }
type Row = { id: string; authConfig: string | null }
type Snapshot = Scope & {
  version: 1
  rowId: string
  before: string | null
  installed: string
}

export interface AuthFixtureStore {
  readSettings(): Promise<Row[]>
  compareAndSet(id: string, expected: string | null, next: string | null): Promise<boolean>
  invalidateCache(): Promise<void>
  close(): Promise<void>
}

export interface AuthFixtureDependencies {
  guard(): void
  scope(): Scope
  readSnapshot(): unknown
  writeSnapshot(snapshot: Snapshot): void
  removeSnapshot(): void
  connect(): Promise<AuthFixtureStore>
}

const PREFIX = 'Auth acceptance fixture: '

function fail(reason: string): never {
  throw new Error(PREFIX + reason)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configuredAuth(raw: string | null): string {
  const config: unknown = raw === null ? {} : JSON.parse(raw)
  if (!record(config)) fail('invalid auth configuration')
  const oauth = config.oauth === undefined ? {} : config.oauth
  if (!record(oauth)) fail('invalid methods')
  return JSON.stringify({
    ...config,
    openSignup: true,
    oauth: { ...oauth, password: true, magicLink: true },
  })
}

function snapshotForScope(value: unknown, scope: Scope): Snapshot | null {
  if (value === null) return null
  if (
    !record(value) ||
    value.version !== 1 ||
    value.runId !== scope.runId ||
    value.runAttempt !== scope.runAttempt ||
    typeof value.rowId !== 'string' ||
    !value.rowId ||
    !(value.before === null || typeof value.before === 'string') ||
    typeof value.installed !== 'string'
  ) {
    fail('snapshot does not belong to this run')
  }
  if (configuredAuth(value.before) !== value.installed) fail('invalid snapshot configuration')
  return value as Snapshot
}

/** Adapters make failure ordering testable without opening a database or SMTP connection. */
export async function runAuthAcceptanceFixture(
  action: string,
  dependencies: AuthFixtureDependencies
): Promise<void> {
  if (action !== 'enable' && action !== 'restore') fail('unknown action')
  // Run the full service/effective-environment guard before any file or DB/Redis adapter.
  dependencies.guard()
  const scope = dependencies.scope()
  if (!/^\d+$/.test(scope.runId) || !/^\d+$/.test(scope.runAttempt)) fail('invalid run identity')
  let snapshot = snapshotForScope(dependencies.readSnapshot(), scope)
  if (action === 'restore' && snapshot === null) return

  const store = await dependencies.connect()
  try {
    const rows = await store.readSettings()
    if (rows.length !== 1) fail('expected exactly one settings row')
    const row = rows[0]
    if (snapshot && snapshot.rowId !== row.id) fail('settings row does not match snapshot')

    if (action === 'enable') {
      if (!snapshot) {
        snapshot = {
          version: 1,
          ...scope,
          rowId: row.id,
          before: row.authConfig,
          installed: configuredAuth(row.authConfig),
        }
        // Exclusive creation retains the original bytes across process crashes/retries.
        dependencies.writeSnapshot(snapshot)
      }
      if (row.authConfig !== snapshot.installed) {
        if (row.authConfig !== snapshot.before) fail('settings changed outside this fixture')
        if (!(await store.compareAndSet(row.id, snapshot.before, snapshot.installed))) {
          fail('settings changed before enabling')
        }
      }
    } else {
      if (!snapshot) fail('missing snapshot')
      // A previous restore may have committed before cache invalidation failed.
      // Exact prior bytes mean retry only the invalidation, never overwrite again.
      if (row.authConfig !== snapshot.before) {
        if (row.authConfig !== snapshot.installed) fail('settings changed outside this fixture')
        if (!(await store.compareAndSet(row.id, snapshot.installed, snapshot.before))) {
          fail('settings changed before restoring')
        }
      }
    }

    // Do not consume the recovery snapshot until the running app can see the restored state.
    await store.invalidateCache()
    if (action === 'restore') dependencies.removeSnapshot()
  } finally {
    await store.close()
  }
}

function dependencies(): AuthFixtureDependencies {
  const scope = () => ({
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
  })
  const snapshotPath = () => {
    const current = scope()
    return resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../.auth/auth-acceptance-' + current.runId + '-' + current.runAttempt + '.json'
    )
  }
  return {
    guard: assertDesignFixtureEnvironmentSync,
    scope,
    readSnapshot() {
      try {
        return JSON.parse(readFileSync(snapshotPath(), 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    writeSnapshot(snapshot) {
      mkdirSync(dirname(snapshotPath()), { recursive: true })
      writeFileSync(snapshotPath(), JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 })
    },
    removeSnapshot() {
      unlinkSync(snapshotPath())
    },
    async connect() {
      // These modules may construct clients; import them only after the guard above.
      const [{ default: postgres }, { getRedis, CACHE_KEYS }] = await Promise.all([
        import('postgres'),
        import('../../src/lib/server/redis'),
      ])
      const sql = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 10 })
      const redis = getRedis()
      return {
        async readSettings() {
          const rows = await sql<{ id: string; auth_config: string | null }[]>`
            SELECT id, auth_config FROM settings ORDER BY created_at ASC LIMIT 2
          `
          return rows.map((row) => ({ id: row.id, authConfig: row.auth_config }))
        },
        async compareAndSet(id, expected, next) {
          const changed = await sql`
            UPDATE settings SET auth_config = ${next}
            WHERE id = ${id} AND auth_config IS NOT DISTINCT FROM ${expected}
            RETURNING id
          `
          return changed.length === 1
        },
        async invalidateCache() {
          // cacheDel swallows Redis errors; fixture ownership requires an acknowledged DEL.
          await redis.del(CACHE_KEYS.TENANT_SETTINGS)
        },
        async close() {
          await Promise.all([sql.end(), redis.quit()])
        },
      }
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] ?? ''
  runAuthAcceptanceFixture(action, dependencies())
    .then(() => console.log(JSON.stringify({ action })))
    .catch((error: unknown) => {
      // Never print DB errors, raw settings, or transport/environment values.
      console.error(
        error instanceof Error && error.message.startsWith(PREFIX)
          ? error.message
          : PREFIX + 'operation failed'
      )
      process.exitCode = 1
    })
}
