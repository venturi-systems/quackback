import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { CustomAttrFilter } from '../user.types'

// DEF-45: a custom attribute number filter (`?customAttrs=seats:gte:5`) cast
// every user's stored value with `::numeric`, so one user whose value was text
// such as "gold" failed the whole users list, and an ILIKE value that ended in
// a backslash failed it too. This suite belongs to the PostgreSQL test gate:
// it runs the production query against fixtures inside a transaction that is
// always rolled back.
const state = vi.hoisted(() => ({ transaction: undefined as object | undefined }))
vi.mock('@/lib/server/db', async () => {
  const schema = await import('@quackback/db/schema')
  const operators = await import('drizzle-orm')
  return {
    ...schema,
    ...operators,
    db: new Proxy(
      {},
      {
        get(_target, key) {
          if (!state.transaction) throw new Error('Queries must stay inside the test transaction')
          const value = Reflect.get(state.transaction, key)
          return typeof value === 'function' ? value.bind(state.transaction) : value
        },
      }
    ),
  }
})
import { principal, user, sql } from '@/lib/server/db'
import { listPortalUsers } from '../user.service'

let client: ReturnType<typeof postgres>
beforeAll(() => {
  const connection = process.env.DATABASE_URL
  if (!connection) throw new Error('The PostgreSQL test gate must supply DATABASE_URL')
  const url = new URL(connection)
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/quackback_test'
  ) {
    throw new Error('User fixtures require the local quackback_test database')
  }
  client = postgres(connection, { max: 1, connect_timeout: 3 })
})
afterAll(async () => {
  if (client) await client.end({ timeout: 1 })
})

/** Stored metadata per fixture user, keyed by the label in the user's name. */
const METADATA: Record<string, string> = {
  gold: '{"seats":"gold"}',
  huge: '{"seats":"1e999999"}',
  none: '{}',
  seven: '{"seats":7}',
  three: '{"seats":"3"}',
  twelve: '{"seats":"12"}',
}

describe('users list filters on PostgreSQL', () => {
  it('compares numbers and patterns without failing on any stored value', async () => {
    const schema = await import('@quackback/db/schema')
    const database = drizzle(client, { schema })
    const rollback = new Error('rollback custom attribute fixtures')
    const marker = `attrs${generateId('user').slice(-10)}`
    try {
      await database.transaction(async (tx) => {
        state.transaction = tx
        try {
          for (const [label, metadata] of Object.entries(METADATA)) {
            const userId = generateId('user')
            await tx.insert(user).values({
              id: userId,
              name: `${marker} ${label}`,
              email: `${marker}-${label}@acme.example`,
              metadata,
            })
            await tx.insert(principal).values({
              id: generateId('principal'),
              userId,
              role: 'user',
              type: 'user',
              createdAt: new Date(),
            })
          }

          /** The labels of the fixture users the list returns, in name order. */
          const labels = async (customAttrs: CustomAttrFilter[]) => {
            const result = await listPortalUsers({ search: marker, sort: 'name', customAttrs })
            return result.items.map((item) => item.name?.slice(marker.length + 1))
          }

          expect(await labels([{ key: 'seats', op: 'gte', value: '5' }])).toEqual([
            'seven',
            'twelve',
          ])
          expect(await labels([{ key: 'seats', op: 'lt', value: '10' }])).toEqual([
            'seven',
            'three',
          ])
          expect(
            await labels([
              { key: 'seats', op: 'gt', value: '-1' },
              { key: 'seats', op: 'lte', value: '12' },
            ])
          ).toEqual(['seven', 'three', 'twelve'])
          // A number comparison with nothing to compare with is skipped.
          expect(await labels([{ key: 'seats', op: 'gt', value: 'abc' }])).toEqual(
            Object.keys(METADATA)
          )

          // ILIKE values match literally. A trailing backslash used to leave
          // the pattern ending in the escape character, which Postgres
          // rejects, and `_` matched any character.
          expect(await labels([{ key: 'seats', op: 'ends_with', value: '\\' }])).toEqual([])
          expect(await labels([{ key: 'seats', op: 'contains', value: '_' }])).toEqual([])
          expect(await labels([{ key: 'seats', op: 'ends_with', value: 'ld' }])).toEqual(['gold'])
          const domain = async (emailDomain: string) =>
            (await listPortalUsers({ search: marker, emailDomain })).total
          expect(await domain('acme.exampl\\')).toBe(0)
          expect(await domain('acme.example')).toBe(Object.keys(METADATA).length)

          // The first and last instants the search params accept (years 1 and
          // 9999 UTC) reach this query and Postgres takes them.
          const bounded = await listPortalUsers({
            search: marker,
            dateFrom: new Date('0001-01-01T00:00:00.000Z'),
            dateTo: new Date('9999-12-31T23:59:59.999Z'),
          })
          expect(bounded.total).toBe(Object.keys(METADATA).length)

          // The cast the guard replaced fails on this data, so the fixtures
          // reach the defect. It runs last: the error aborts the transaction.
          await expect(tx.execute(sql`select (${'gold'}::text)::numeric`)).rejects.toThrow()
          throw rollback
        } finally {
          state.transaction = undefined
        }
      })
    } catch (error) {
      if (error !== rollback) throw error
    }
  })
})
