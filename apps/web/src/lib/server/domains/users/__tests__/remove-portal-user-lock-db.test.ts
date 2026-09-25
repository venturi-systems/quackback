/**
 * DEF-64 (landing-page#2309): there is never a path to zero administrators.
 *
 * Removing a portal user used to check that the principal was a contributor
 * and then delete it by id alone, outside the team-role lock. A promotion that
 * landed between the check and the delete therefore removed a new team member
 * or administrator. removePortalUser now checks and deletes in the one
 * transaction that holds the team-role advisory lock, the lock every role
 * write takes, so it waits for a promotion in flight and sees its result.
 *
 * This suite belongs to the PostgreSQL test gate and drives the real
 * removePortalUser, withTeamRoleLock and changeTeamRole over real connections.
 * A third connection holds the lock first, so each case runs in exactly the
 * order it names. The fixtures live in a throwaway schema, dropped after.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId, toUuid } from '@quackback/ids'
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

const SCHEMA = `remove_user_lock_${generateId('user').slice(-12).toLowerCase()}`
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
    throw new Error('Remove-user lock fixtures require the local quackback_test database')
  }

  // One connection holds the lock and one watches pg_locks; the app pool
  // serves the requests and the fixtures, with the throwaway schema first on
  // its search path so the unqualified table names resolve there.
  // onnotice: DROP SCHEMA ... CASCADE reports each dropped table as a NOTICE.
  admin = postgres(connection, { max: 2, connect_timeout: 3, onnotice: () => {} })
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
  await import('../user.service')
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

interface Person {
  name: string
  userId: `user_${string}`
  principalId: `principal_${string}`
}

/** A person at the team domain with a verified address and a GitHub link. */
async function seed(name: string, role: 'admin' | 'user'): Promise<Person> {
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
    role,
    type: 'user',
    createdAt: new Date(),
  })
  await db.insert(account).values({
    id: generateId('account'),
    userId,
    providerId: 'github',
    accountId: `github-${name}`,
    updatedAt: new Date(),
  })
  return { name, userId, principalId }
}

beforeEach(async () => {
  vi.stubEnv('VENTURI_TEAM_EMAIL_DOMAINS', 'acme.example')
  await admin.unsafe(`TRUNCATE "${SCHEMA}"."account", "${SCHEMA}"."principal", "${SCHEMA}"."user"`)
})

/** The stored role of a principal, or null once it is removed. */
async function roleOf(who: Person): Promise<string | null> {
  const [row] = await db
    .select({ role: schema.principal.role })
    .from(schema.principal)
    .where(eq(schema.principal.id, who.principalId))
  return row?.role ?? null
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
 * every one of them is queued on the lock, then commit and settle them. With
 * `promoteWhileHolding`, the holder first makes that person an administrator
 * in its own transaction, as a promotion in flight would.
 */
async function behindTheLock(
  attempts: Array<{ who: string; run: () => Promise<unknown> }>,
  promoteWhileHolding?: Person
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
    if (promoteWhileHolding) {
      // Raw SQL bypasses the TypeID column mapping: the stored id is the UUID.
      await tx`
        UPDATE ${tx(SCHEMA)}.principal SET role = 'admin'
        WHERE id = ${toUuid(promoteWhileHolding.principalId)}
      `
    }
    holding()
    await released
  })

  // A holder that fails before taking the lock rejects here instead of hanging.
  await Promise.race([held, holder])
  const pending = attempts.map(({ who, run }) =>
    run().then(
      (value): Outcome => ({ who, value }),
      (error: unknown): Outcome => ({ who, error })
    )
  )
  try {
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

async function remove(who: Person) {
  const { removePortalUser } = await import('../user.service')
  return removePortalUser(who.principalId)
}

describe('removing a portal user while a promotion is in flight', () => {
  it('waits for a promotion that holds the lock and refuses the new administrator', async () => {
    await seed('alice', 'admin')
    const carol = await seed('carol', 'user')

    // The promotion is written, not yet committed, while the lock is held.
    // Before DEF-64 the removal read "contributor" here and deleted by id.
    const [outcome] = await behindTheLock([{ who: 'remove', run: () => remove(carol) }], carol)

    expect(outcome).toHaveProperty('error')
    expect((outcome as { error: unknown }).error).toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    expect(await roleOf(carol)).toBe('admin')
  })

  it('serializes a removal with a concurrent promotion of the same person', async () => {
    const { changeTeamRole } = await import('@/lib/server/domains/principals/team-designation')
    const alice = await seed('alice', 'admin')
    const carol = await seed('carol', 'user')

    const outcomes = await behindTheLock([
      { who: 'remove', run: () => remove(carol) },
      {
        who: 'promote',
        run: () =>
          changeTeamRole({
            principalId: carol.principalId,
            newRole: 'admin',
            actingPrincipalId: alice.principalId,
            requireTeamTarget: false,
          }),
      },
    ])

    // Whichever takes the lock first wins; the other sees its committed result.
    const refused = outcomes.filter((o): o is { who: string; error: unknown } => 'error' in o)
    expect(refused).toHaveLength(1)
    expect(refused[0].error).toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    if (refused[0].who === 'remove') {
      // The promotion committed first: Carol is an administrator and stays one.
      expect(await roleOf(carol)).toBe('admin')
    } else {
      // The removal committed first: there was nobody left to promote.
      expect(await roleOf(carol)).toBeNull()
    }
    expect(await roleOf(alice)).toBe('admin')
  })

  it('removes a contributor when nothing else is in flight', async () => {
    const carol = await seed('carol', 'user')
    await expect(remove(carol)).resolves.toBeUndefined()
    expect(await roleOf(carol)).toBeNull()
  })

  it('refuses to remove an administrator', async () => {
    const alice = await seed('alice', 'admin')
    await expect(remove(alice)).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
    expect(await roleOf(alice)).toBe('admin')
  })
})
