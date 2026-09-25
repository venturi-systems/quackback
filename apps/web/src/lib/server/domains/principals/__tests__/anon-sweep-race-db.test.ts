/**
 * HYG-32 (landing-page#2309): the anonymous-principal sweep deletes only what
 * is still empty when it deletes.
 *
 * The sweep shortlists empty anonymous principals with one scan and deletes
 * them later, one transaction each. It used to delete each by id alone, so a
 * candidate that voted, started a live session or was absorbed by a sign-up
 * between the scan and its delete was deleted anyway: votes cascade, so the
 * vote went with it, and a sign-up's principal, sessions and user row went
 * too. Each delete now locks the principal and its user, skips them if anyone
 * holds either, and re-checks the scan's own predicate before deleting.
 *
 * This suite belongs to the PostgreSQL test gate and drives the real
 * sweepAnonymousPrincipals over real connections. Each concurrent change is
 * made on a second connection at the exact point the race needs: after the
 * scan has returned and before the first per-principal transaction, or (for
 * the in-flight case) held uncommitted while the sweep runs. The fixtures
 * live in a throwaway schema that carries the production foreign keys onto
 * principal and user, so the cascades behave as they do in production. The
 * schema is dropped after.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { and, eq, gt } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const state = vi.hoisted(() => ({
  db: undefined as object | undefined,
  /** Runs once, just before the sweep opens its first transaction. */
  beforeFirstTransaction: undefined as (() => Promise<void>) | undefined,
  hookRan: false,
}))
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
          if (typeof value !== 'function') return value
          const bound = value.bind(state.db)
          if (key !== 'transaction') return bound
          // The race window: the scan has returned its candidates and no
          // candidate has been locked or deleted yet.
          return async (...args: unknown[]) => {
            const hook = state.beforeFirstTransaction
            state.beforeFirstTransaction = undefined
            if (hook) {
              await hook()
              state.hookRan = true
            }
            return bound(...args)
          }
        },
      }
    ),
  }
})

const SCHEMA = `anon_sweep_${generateId('user').slice(-12).toLowerCase()}`
const APP_NAME = `anon-sweep-race-${SCHEMA.slice(-12)}`
const DAY_MS = 86_400_000
const LOCK_WAIT_TIMEOUT_MS = 10_000
// Every table the sweep reads or deletes. All of them are created in the
// throwaway schema, so the sweep sees only this suite's rows.
const TABLES = [
  'user',
  'principal',
  'session',
  'posts',
  'votes',
  'comments',
  'comment_reactions',
  'conversations',
  'chat_messages',
  'post_subscriptions',
  'in_app_notifications',
]

let admin: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let writer: ReturnType<typeof postgres>
// Loaded with import(), as the other PostgreSQL gate suites do: lib/ code
// never imports @quackback/db statically (eslint no-restricted-imports).
let schema: typeof import('@quackback/db/schema')
let db: PostgresJsDatabase<typeof schema>
/** A second connection pool: the visitor acting while the sweep runs. */
let visitor: PostgresJsDatabase<typeof schema>

beforeAll(async () => {
  const connection = process.env.DATABASE_URL
  if (!connection) throw new Error('The PostgreSQL test gate must supply DATABASE_URL')
  const url = new URL(connection)
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/quackback_test'
  ) {
    throw new Error('Anon sweep fixtures require the local quackback_test database')
  }

  // onnotice: DROP SCHEMA ... CASCADE reports each dropped table as a NOTICE.
  admin = postgres(connection, { max: 2, connect_timeout: 3, onnotice: () => {} })
  await admin.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
  for (const table of TABLES) {
    await admin.unsafe(`CREATE TABLE "${SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`)
  }
  // LIKE copies no foreign keys. Copy the production ones that point at
  // principal or user, verbatim, so a delete cascades and a referencing write
  // locks the referenced row exactly as it does in production.
  const foreignKeys = await admin<Array<{ source: string; name: string; definition: string }>>`
    SELECT src.relname AS source, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class ref ON ref.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND ref.relnamespace = src.relnamespace
      AND src.relname::text = ANY(${TABLES}::text[])
      AND ref.relname IN ('principal', 'user')
  `
  // pg_get_constraintdef leaves a table on the search path unqualified; strip
  // an explicit public. too, so every reference resolves to the copies below.
  for (const fk of foreignKeys) {
    fk.definition = fk.definition.replace(/REFERENCES public\./g, 'REFERENCES ')
  }
  const copied = foreignKeys.map((fk) => `${fk.source}: ${fk.definition}`)
  // The cases below depend on these three behaving as in production.
  for (const expected of [
    /^votes: FOREIGN KEY \(principal_id\) REFERENCES principal\(id\) ON DELETE CASCADE/,
    /^session: FOREIGN KEY \(user_id\) REFERENCES "user"\(id\) ON DELETE CASCADE/,
    /^principal: FOREIGN KEY \(user_id\) REFERENCES "user"\(id\) ON DELETE CASCADE/,
  ]) {
    if (!copied.some((fk) => expected.test(fk))) {
      throw new Error(`Expected a production foreign key matching ${expected}; found ${copied}`)
    }
  }
  await admin.begin(async (tx) => {
    // The definitions name principal and "user" unqualified, so they resolve
    // to the throwaway schema's tables here.
    await tx.unsafe(`SET LOCAL search_path TO "${SCHEMA}"`)
    for (const fk of foreignKeys) {
      await tx.unsafe(
        `ALTER TABLE "${SCHEMA}"."${fk.source}" ADD CONSTRAINT "${fk.name}" ${fk.definition}`
      )
    }
  })

  app = postgres(connection, {
    max: 4,
    connect_timeout: 3,
    connection: { search_path: `${SCHEMA}, public`, application_name: APP_NAME },
  })
  writer = postgres(connection, {
    max: 2,
    connect_timeout: 3,
    connection: { search_path: `${SCHEMA}, public` },
  })
  schema = await import('@quackback/db/schema')
  db = drizzle(app, { schema })
  visitor = drizzle(writer, { schema })
  state.db = db
  await import('../anon-sweep.service')
})

afterAll(async () => {
  state.db = undefined
  if (app) await app.end({ timeout: 1 })
  if (writer) await writer.end({ timeout: 1 })
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await admin.end({ timeout: 1 })
  }
})

beforeEach(async () => {
  state.beforeFirstTransaction = undefined
  state.hookRan = false
  await admin.unsafe(`TRUNCATE ${TABLES.map((t) => `"${SCHEMA}"."${t}"`).join(', ')}`)
})

interface Visitor {
  name: string
  userId: `user_${string}`
  principalId: `principal_${string}`
}

/**
 * An anonymous visitor who came 60 days ago, did nothing, and whose only
 * session expired long ago: exactly what the sweep exists to remove.
 */
async function seedIdleAnon(name: string): Promise<Visitor> {
  const { user, principal, session } = schema
  const userId = generateId('user')
  const principalId = generateId('principal')
  const createdAt = new Date(Date.now() - 60 * DAY_MS)
  await db.insert(user).values({
    id: userId,
    name,
    isAnonymous: true,
    createdAt,
    updatedAt: createdAt,
  })
  await db.insert(principal).values({
    id: principalId,
    userId,
    role: 'user',
    type: 'anonymous',
    displayName: name,
    createdAt,
  })
  await db.insert(session).values({
    id: randomUUID(),
    token: randomUUID(),
    userId,
    expiresAt: new Date(createdAt.getTime() + 7 * DAY_MS),
    createdAt,
    updatedAt: createdAt,
  })
  return { name, userId, principalId }
}

async function sweep() {
  const { sweepAnonymousPrincipals } = await import('../anon-sweep.service')
  return sweepAnonymousPrincipals({ olderThanDays: 30 })
}

async function principalOf(who: Visitor) {
  const [row] = await db
    .select({ type: schema.principal.type, role: schema.principal.role })
    .from(schema.principal)
    .where(eq(schema.principal.id, who.principalId))
  return row ?? null
}

async function userExists(who: Visitor): Promise<boolean> {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, who.userId))
  return rows.length === 1
}

async function votesBy(who: Visitor): Promise<number> {
  const rows = await db
    .select({ id: schema.votes.id })
    .from(schema.votes)
    .where(eq(schema.votes.principalId, who.principalId))
  return rows.length
}

async function liveSessionsOf(who: Visitor): Promise<number> {
  const rows = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(and(eq(schema.session.userId, who.userId), gt(schema.session.expiresAt, new Date())))
  return rows.length
}

function liveSession(userId: Visitor['userId']) {
  const now = new Date()
  return {
    id: randomUUID(),
    token: randomUUID(),
    userId,
    expiresAt: new Date(now.getTime() + 7 * DAY_MS),
    createdAt: now,
    updatedAt: now,
  }
}

describe('the anonymous-principal sweep', () => {
  it('deletes a truly empty anonymous principal with its sessions and user', async () => {
    const idle = await seedIdleAnon('idle')

    expect(await sweep()).toEqual({ candidates: 1, deleted: 1 })

    expect(await principalOf(idle)).toBeNull()
    expect(await userExists(idle)).toBe(false)
    const sessions = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, idle.userId))
    expect(sessions).toHaveLength(0)
  })

  it.each([
    {
      change: 'casts a vote',
      async act(who: Visitor) {
        await visitor.insert(schema.votes).values({
          postId: generateId('post'),
          principalId: who.principalId,
        })
      },
      async check(who: Visitor) {
        expect(await votesBy(who)).toBe(1)
        expect(await principalOf(who)).toEqual({ type: 'anonymous', role: 'user' })
      },
    },
    {
      change: 'starts a live session',
      async act(who: Visitor) {
        await visitor.insert(schema.session).values(liveSession(who.userId))
      },
      async check(who: Visitor) {
        expect(await liveSessionsOf(who)).toBe(1)
        expect(await principalOf(who)).toEqual({ type: 'anonymous', role: 'user' })
      },
    },
    {
      // auth/index.ts onLinkAccount, sign-up branch: the anonymous user takes
      // the new identity, the sign-up's session moves to it, and the principal
      // becomes a contributor (merge-anonymous.ts absorbedSignUpPrincipal).
      change: 'is absorbed by a sign-up',
      async act(who: Visitor) {
        await visitor.transaction(async (tx) => {
          await tx.insert(schema.session).values(liveSession(who.userId))
          await tx
            .update(schema.user)
            .set({
              name: 'Dana Example',
              email: `dana-${who.name}@acme.example`,
              emailVerified: true,
              isAnonymous: false,
            })
            .where(eq(schema.user.id, who.userId))
          await tx
            .update(schema.principal)
            .set({ type: 'user', role: 'user', displayName: 'Dana Example' })
            .where(eq(schema.principal.id, who.principalId))
        })
      },
      async check(who: Visitor) {
        expect(await principalOf(who)).toEqual({ type: 'user', role: 'user' })
        expect(await liveSessionsOf(who)).toBe(1)
      },
    },
  ])(
    'keeps a candidate that $change after the scan, and still sweeps an empty one',
    async ({ act, check }) => {
      const idle = await seedIdleAnon('idle')
      const active = await seedIdleAnon('active')
      state.beforeFirstTransaction = () => act(active)

      const result = await sweep()

      // The change landed inside the window: after the scan chose both.
      expect(state.hookRan).toBe(true)
      expect(result).toEqual({ candidates: 2, deleted: 1 })
      await check(active)
      expect(await userExists(active)).toBe(true)
      expect(await principalOf(idle)).toBeNull()
      expect(await userExists(idle)).toBe(false)
    }
  )

  it('skips a candidate whose vote is still being written, and the vote lands', async () => {
    const voting = await seedIdleAnon('voting')

    // The vote's transaction inserts and holds, uncommitted: the scan cannot
    // see it, and the vote's foreign key holds a key-share lock on the
    // principal row until it commits.
    let commit!: () => void
    const committed = new Promise<void>((resolve) => {
      commit = resolve
    })
    let inserted!: () => void
    const insertedVote = new Promise<void>((resolve) => {
      inserted = resolve
    })
    const writing = visitor.transaction(async (tx) => {
      await tx.insert(schema.votes).values({
        postId: generateId('post'),
        principalId: voting.principalId,
      })
      inserted()
      await committed
    })
    await Promise.race([insertedVote, writing])

    let settled = false
    const sweeping = sweep().finally(() => {
      settled = true
    })
    // Either the sweep finishes on its own, having skipped the held row, or it
    // queues behind the uncommitted vote and would delete the principal (and,
    // by cascade, the vote) the moment the vote commits.
    let outcome: 'finished' | 'blocked' | undefined
    try {
      const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
      while (!outcome) {
        if (settled) {
          outcome = 'finished'
          break
        }
        const [row] = await admin<[{ waiting: number }]>`
          SELECT count(*)::int AS waiting
          FROM pg_stat_activity
          WHERE application_name = ${APP_NAME} AND wait_event_type = 'Lock'
        `
        if (row.waiting > 0) {
          outcome = 'blocked'
          break
        }
        if (Date.now() > deadline) throw new Error('The sweep neither finished nor blocked')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } finally {
      commit()
      await writing
    }
    const result = await sweeping

    expect(outcome).toBe('finished')
    expect(result).toEqual({ candidates: 1, deleted: 0 })
    expect(await principalOf(voting)).toEqual({ type: 'anonymous', role: 'user' })
    expect(await votesBy(voting)).toBe(1)
    expect(await userExists(voting)).toBe(true)
  })
})
