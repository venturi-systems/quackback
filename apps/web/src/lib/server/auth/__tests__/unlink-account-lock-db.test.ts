/**
 * DEF-62 (landing-page#2309): there is never a path to zero administrators.
 *
 * Two administrators who each unlink their last Google or GitHub account at
 * the same moment must not both succeed. The unlink gate used to count the
 * other eligible administrators under the team-role advisory lock and then
 * release it, leaving the delete to Better Auth: two requests queued on the
 * lock each counted the other, and both deletes followed. The gate now reads,
 * counts and deletes in the one transaction that holds the lock, the same
 * lock every role write takes.
 *
 * This suite belongs to the PostgreSQL test gate and drives the real gate,
 * the real withTeamRoleLock and countEligibleAdmins, and real concurrent
 * connections. Both requests are made to wait on the lock at once, behind a
 * third connection that holds it, so they run in the order that let both
 * pass before. The fixtures live in a throwaway schema, so the count of
 * eligible administrators sees only them, and the schema is dropped after.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { eq } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const state = vi.hoisted(() => ({ db: undefined as object | undefined }))
vi.mock('@/lib/server/db', async () => {
  const tables = await import('@quackback/db/schema')
  const operators = await import('drizzle-orm')
  return {
    ...tables,
    ...operators,
    db: new Proxy(
      {},
      {
        get(_target, key) {
          if (!state.db) throw new Error('The test database is not connected yet')
          const value = Reflect.get(state.db, key)
          return typeof value === 'function' ? value.bind(state.db) : value
        },
      }
    ),
  }
})
vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(),
}))

const SCHEMA = `unlink_lock_${generateId('user').slice(-12).toLowerCase()}`
const LOCK_WAIT_TIMEOUT_MS = 10_000

let admin: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
// Loaded with import(), as the other PostgreSQL gate suites do: lib/ code
// never imports @quackback/db statically (eslint no-restricted-imports).
let schema: typeof import('@quackback/db/schema')
let db: PostgresJsDatabase<typeof schema>

beforeAll(async () => {
  const connection = process.env.DATABASE_URL
  if (!connection) throw new Error('The PostgreSQL test gate must supply DATABASE_URL')
  const url = new URL(connection)
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/quackback_test'
  ) {
    throw new Error('Unlink lock fixtures require the local quackback_test database')
  }

  // One connection holds the lock and one watches pg_locks; the app pool
  // serves the two requests and the fixtures, with the throwaway schema first
  // on its search path so the unqualified table names resolve there.
  admin = postgres(connection, { max: 2, connect_timeout: 3 })
  await admin.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
  for (const table of ['user', 'principal', 'account']) {
    await admin.unsafe(`CREATE TABLE "${SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`)
  }
  app = postgres(connection, {
    max: 4,
    connect_timeout: 3,
    connection: { search_path: `${SCHEMA}, public` },
  })
  schema = await import('@quackback/db/schema')
  db = drizzle(app, { schema })
  state.db = db
  // Load the modules now, so each request reaches the lock in milliseconds.
  await import('../hooks')
  await import('@/lib/server/domains/principals/team-designation')
  await import('@/lib/server/domains/principals/team-identity')
})

afterAll(async () => {
  state.db = undefined
  vi.unstubAllEnvs()
  if (app) await app.end({ timeout: 1 })
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await admin.end({ timeout: 1 })
  }
})

interface Admin {
  name: string
  userId: `user_${string}`
  principalId: `principal_${string}`
}

/** An administrator whose only team identity is one GitHub link. */
async function seedAdmin(name: string): Promise<Admin> {
  const { user, principal, account } = schema
  const userId = generateId('user')
  const principalId = generateId('principal')
  await db.insert(user).values({
    id: userId,
    name,
    email: `${name}@acme.example`,
    emailVerified: true,
  })
  await db.insert(principal).values({
    id: principalId,
    userId,
    role: 'admin',
    type: 'user',
    createdAt: new Date(),
  })
  // A password credential too, so Better Auth's "last account" rule is not
  // what refuses the unlink.
  await db.insert(account).values([
    {
      id: generateId('account'),
      userId,
      providerId: 'github',
      accountId: `github-${name}`,
      updatedAt: new Date(),
    },
    {
      id: generateId('account'),
      userId,
      providerId: 'credential',
      accountId: userId,
      updatedAt: new Date(),
    },
  ])
  return { name, userId, principalId }
}

beforeEach(async () => {
  vi.stubEnv('VENTURI_TEAM_EMAIL_DOMAINS', 'acme.example')
  await admin.unsafe(`TRUNCATE "${SCHEMA}"."account", "${SCHEMA}"."principal", "${SCHEMA}"."user"`)
})

async function eligibleAdmins(exclude?: Admin): Promise<number> {
  const { countEligibleAdmins } = await import('@/lib/server/domains/principals/team-designation')
  return db.transaction((tx) => countEligibleAdmins(tx, exclude?.principalId))
}

/** Requests waiting for the team-role advisory lock right now. */
async function lockWaiters(): Promise<number> {
  const { TEAM_ROLE_LOCK_KEY } = await import('@/lib/server/domains/principals/team-designation')
  // A bigint advisory key shows its high half in classid, its low half in objid.
  const [row] = await admin<[{ waiting: number }]>`
    WITH k AS (SELECT hashtext(${TEAM_ROLE_LOCK_KEY})::bigint AS key)
    SELECT count(*)::int AS waiting
    FROM pg_locks, k
    WHERE pg_locks.locktype = 'advisory'
      AND NOT pg_locks.granted
      AND pg_locks.objsubid = 1
      AND pg_locks.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND pg_locks.classid = ((k.key >> 32) & 4294967295)::oid
      AND pg_locks.objid = (k.key & 4294967295)::oid
  `
  return row.waiting
}

type Outcome = { who: string; value: unknown } | { who: string; error: unknown }

/**
 * Hold the team-role lock on its own connection, start `attempts`, wait until
 * every one of them is queued on the lock, then release it and settle them.
 */
async function raceBehindTheLock(
  attempts: Array<{ who: string; run: () => Promise<unknown> }>
): Promise<Outcome[]> {
  const { TEAM_ROLE_LOCK_KEY } = await import('@/lib/server/domains/principals/team-designation')
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let holding!: () => void
  const held = new Promise<void>((resolve) => {
    holding = resolve
  })
  const holder = admin.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${TEAM_ROLE_LOCK_KEY}))`
    holding()
    await released
  })

  let pending!: Array<Promise<Outcome>>
  try {
    await held
    pending = attempts.map(({ who, run }) =>
      run().then(
        (value): Outcome => ({ who, value }),
        (error: unknown): Outcome => ({ who, error })
      )
    )
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
    while ((await lockWaiters()) < attempts.length) {
      if (Date.now() > deadline) {
        throw new Error('The requests did not all queue on the team-role lock in time')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } finally {
    release()
    await holder
  }
  return Promise.all(pending)
}

async function unlinkLastGithub(who: Admin) {
  const { handleUnlinkAccountGate } = await import('../hooks')
  return handleUnlinkAccountGate(
    {
      path: '/unlink-account',
      body: { providerId: 'github' },
      context: { sessionConfig: { freshAge: 0 } },
    },
    (async () => ({ user: { id: who.userId }, session: { createdAt: new Date() } })) as never
  )
}

async function githubLinkOwners(): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.account.userId })
    .from(schema.account)
    .where(eq(schema.account.providerId, 'github'))
  return rows.map((row) => row.userId)
}

describe('unlinking the last team identity of the last two administrators', () => {
  it('lets exactly one of two concurrent unlinks through', async () => {
    const alice = await seedAdmin('alice')
    const bob = await seedAdmin('bob')
    // Before the race each one alone may unlink: the other still counts.
    expect(await eligibleAdmins()).toBe(2)
    expect(await eligibleAdmins(alice)).toBe(1)
    expect(await eligibleAdmins(bob)).toBe(1)

    const outcomes = await raceBehindTheLock(
      [alice, bob].map((who) => ({ who: who.name, run: () => unlinkLastGithub(who) }))
    )

    const unlinked = outcomes.filter((o) => 'value' in o)
    const refused = outcomes.filter((o): o is { who: string; error: unknown } => 'error' in o)
    expect(unlinked).toHaveLength(1)
    expect(unlinked[0]).toMatchObject({ value: { status: true } })
    expect(refused).toHaveLength(1)
    expect(refused[0].error).toMatchObject({
      body: expect.objectContaining({ code: 'last_admin_identity' }),
    })

    // The refused administrator keeps the GitHub link and can still act.
    const survivor = refused[0].who === 'alice' ? alice : bob
    expect(await githubLinkOwners()).toEqual([survivor.userId])
    expect(await eligibleAdmins()).toBe(1)
  })

  it('serializes an unlink with a concurrent demotion of the other administrator', async () => {
    const { changeTeamRole } = await import('@/lib/server/domains/principals/team-designation')
    const alice = await seedAdmin('alice')
    const bob = await seedAdmin('bob')

    const outcomes = await raceBehindTheLock([
      { who: 'unlink', run: () => unlinkLastGithub(alice) },
      {
        who: 'demote',
        run: () =>
          changeTeamRole({
            principalId: bob.principalId,
            newRole: 'member',
            actingPrincipalId: alice.principalId,
            requireTeamTarget: true,
          }),
      },
    ])

    // Whichever takes the lock first wins; the other sees its committed result.
    const refused = outcomes.filter((o): o is { who: string; error: unknown } => 'error' in o)
    expect(refused).toHaveLength(1)
    expect(refused[0].error).toMatchObject(
      refused[0].who === 'unlink'
        ? { body: expect.objectContaining({ code: 'last_admin_identity' }) }
        : { code: 'LAST_ADMIN' }
    )
    expect(await eligibleAdmins()).toBe(1)
  })
})
