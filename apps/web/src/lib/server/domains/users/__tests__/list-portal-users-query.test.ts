import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortalUserListParams } from '../user.types'
import { fromUuid } from '@quackback/ids'

const state = vi.hoisted(() => ({
  queries: [] as { sql: string; params: unknown[] }[],
  rows: [] as unknown[][],
}))

// Exercise the real Drizzle builder and schema; only the database transport is
// replaced. This catches invalid CTE references and keeps query shapes visible.
vi.mock('@/lib/server/db', async () => {
  const operators = await import('drizzle-orm')
  const schema = await import('@quackback/db/schema')
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  return {
    ...operators,
    ...schema,
    db: drizzle(async (query, params) => {
      state.queries.push({ sql: query, params })
      if (query.startsWith('select count(*)::int')) return { rows: [[21]] }
      if (query.startsWith('select "user_segments".')) return { rows: [] }
      return { rows: state.rows }
    }),
  }
})

import { listPortalUsers } from '../user.service'

beforeEach(() => {
  state.queries = []
  state.rows = []
})

describe('portal user activity query bounds', () => {
  it.each(['newest', 'oldest', 'name'] as const)(
    'pages %s users before activity aggregates',
    async (sort) => {
      await listPortalUsers({ sort, page: 3, limit: 20, search: 'alice', verified: true })
      const main = state.queries.find((query) => query.sql.startsWith('with '))!
      expect(main).toBeDefined()
      const page = main.sql.slice(0, main.sql.indexOf(') select '))
      expect(page).toContain('"user_page" as (select')
      expect(page).toContain('inner join "user"')
      expect(page).toContain('limit $')
      expect(page).toContain('offset $')
      const direction = sort === 'newest' ? 'desc' : 'asc'
      const pageSortColumn = sort === 'name' ? '"user"."name"' : '"principal"."created_at"'
      const resultSortColumn = sort === 'name' ? '"user_page"."name"' : '"user_page"."created_at"'
      expect(page).toContain(`order by ${pageSortColumn} ${direction}, "principal"."id" asc`)
      expect(main.sql).toMatch(
        new RegExp(`order by ${resultSortColumn} ${direction}, "page_principal_id" asc$`)
      )
      expect(page).not.toMatch(/"posts"|"comments"|"votes"/)
      for (const table of ['posts', 'comments', 'votes']) {
        expect(main.sql).toContain(
          `"${table}"."principal_id" in (select "page_principal_id" from "user_page")`
        )
      }
      expect(main.sql).toContain('"posts"."deleted_at" is null')
      expect(main.sql).toContain('"comments"."deleted_at" is null')
      expect(main.params).toContain('%alice%')
      expect(main.params).toContain(true)
      expect(main.params).toContain('user')
      expect(main.params.slice(-2)).toEqual([20, 40])
      const total = state.queries.find((query) => query.sql.startsWith('select count(*)::int'))!
      expect(total.sql).not.toMatch(/"posts"|"comments"|"votes"|user_page/)
      expect(total.params).toContain('%alice%')
    }
  )

  it.each(['most_active', 'most_posts', 'most_comments', 'most_votes'] as const)(
    'retains global aggregates for %s sorting',
    async (sort) => {
      await listPortalUsers({ sort })
      expect(state.queries.some((query) => query.sql.includes('user_page'))).toBe(false)
      expect(state.queries[0].sql).toContain('group by "posts"."principal_id"')
      expect(state.queries[0].sql).toContain('left join')
      expect(state.queries[0].sql.split('order by ')[1]).not.toContain('"principal"."id"')
      expect(state.queries[1].sql).not.toContain('left join')
    }
  )

  for (const field of ['postCount', 'commentCount', 'voteCount'] as const) {
    it.each(['gt', 'gte', 'lt', 'lte', 'eq'] as const)(
      `retains pre-limit ${field} %s filters and totals`,
      async (op) => {
        await listPortalUsers({ [field]: { op, value: 0 }, sort: 'name' })
        expect(state.queries.some((query) => query.sql.includes('user_page'))).toBe(false)
        expect(state.queries[0].sql).toContain('left join')
        expect(state.queries[1].sql).toContain('left join')
        expect(state.queries[1].params).toContain(0)
      }
    )
  }

  it('keeps zero counts, DTO mapping and total/hasMore semantics', async () => {
    state.rows = [
      [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'Alice',
        'alice@example.com',
        null,
        false,
        '{"plan":"pro"}',
        '2025-01-01 00:00:00+00',
        0,
        0,
        0,
      ],
    ]
    const result = await listPortalUsers({ limit: 20 })
    expect(result.total).toBe(21)
    expect(result.hasMore).toBe(true)
    expect(result.items).toEqual([
      {
        principalId: fromUuid('principal', '11111111-1111-4111-8111-111111111111'),
        userId: fromUuid('user', '22222222-2222-4222-8222-222222222222'),
        name: 'Alice',
        email: 'alice@example.com',
        image: null,
        emailVerified: false,
        metadata: '{"plan":"pro"}',
        joinedAt: new Date('2025-01-01T00:00:00Z'),
        postCount: 0,
        commentCount: 0,
        voteCount: 0,
        segments: [],
      },
    ])
  })

  it('keeps anonymous, segment and metadata predicates within the page', async () => {
    const params: PortalUserListParams = {
      includeAnonymous: true,
      emailDomain: 'example.com',
      dateFrom: new Date('2024-01-01T00:00:00Z'),
      customAttrs: [{ key: 'plan', op: 'eq', value: 'pro' }],
      segmentIds: [fromUuid('segment', '33333333-3333-4333-8333-333333333333')],
    }
    await listPortalUsers(params)
    const main = state.queries[0]
    const page = main.sql.slice(0, main.sql.indexOf(') select '))
    expect(page).toContain('"user_segments"')
    expect(page).toContain('::jsonb->>')
    expect(page).not.toContain('"principal"."type"')
    expect(main.params).toEqual(
      expect.arrayContaining([
        '%@example.com',
        'plan',
        'pro',
        '33333333-3333-4333-8333-333333333333',
        '2024-01-01T00:00:00.000Z',
      ])
    )
  })
})
