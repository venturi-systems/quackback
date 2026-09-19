import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangelogId } from '@quackback/ids'

// vi.hoisted so the vi.mock factory below can reference these during the
// hoisted static-import phase. The module under test is then imported
// statically at the top of the file — its (large) module graph loads during
// file collection instead of inside the first test body, where the one-time
// import cost is charged against a single test's timeout and a timeout firing
// mid-import() corrupts the module graph for every later test in the file.
const {
  mockEntryFindFirst,
  mockEntryFindMany,
  mockStatusesFindMany,
  mockSelect,
  mockUpdateSet,
  mockUpdateWhere,
  mockUpdateReturning,
  changelogEntriesTable,
} = vi.hoisted(() => ({
  mockEntryFindFirst: vi.fn(),
  mockEntryFindMany: vi.fn(),
  mockStatusesFindMany: vi.fn(),
  mockSelect: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockUpdateReturning: vi.fn(),
  changelogEntriesTable: {
    id: { name: 'id' },
    publishedAt: { name: 'published_at' },
    deletedAt: { name: 'deleted_at' },
  },
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      changelogEntries: {
        findFirst: (...args: unknown[]) => mockEntryFindFirst(...args),
        findMany: (...args: unknown[]) => mockEntryFindMany(...args),
      },
      postStatuses: {
        findMany: (...args: unknown[]) => mockStatusesFindMany(...args),
      },
    },
    select: (...args: unknown[]) => mockSelect(...args),
    update: () => ({
      set: (values: unknown) => {
        mockUpdateSet(values)
        return {
          where: (...args: unknown[]) => {
            mockUpdateWhere(...args)
            // `.returning()` for soft-delete writes; `.catch()` for the
            // fire-and-forget view-count increment in getPublicChangelogById.
            return { returning: () => mockUpdateReturning(), catch: () => {} }
          },
        }
      },
    }),
  },
  changelogEntries: changelogEntriesTable,
  changelogEntryPosts: { changelogEntryId: 'changelog_entry_id', postId: 'post_id' },
  posts: {
    id: 'posts.id',
    title: 'posts.title',
    voteCount: 'posts.voteCount',
    boardId: 'posts.boardId',
    statusId: 'posts.statusId',
    deletedAt: 'posts.deletedAt',
    moderationState: 'posts.moderationState',
  },
  boards: {
    id: 'boards.id',
    slug: 'boards.slug',
    access: 'boards.access',
    deletedAt: 'boards.deletedAt',
  },
  postStatuses: { id: 'id' },
  eq: vi.fn((col, val) => ({ kind: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ kind: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ kind: 'or', args })),
  isNull: vi.fn((col) => ({ kind: 'isNull', col })),
  isNotNull: vi.fn((col) => ({ kind: 'isNotNull', col })),
  lt: vi.fn((col, val) => ({ kind: 'lt', col, val })),
  lte: vi.fn((col, val) => ({ kind: 'lte', col, val })),
  desc: vi.fn((col) => ({ kind: 'desc', col })),
  inArray: vi.fn((col, vals) => ({ kind: 'inArray', col, vals })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => ({
      kind: 'sql',
      strings: Array.from(strings),
    })),
    { raw: vi.fn() }
  ),
}))

import { getPublicChangelogById, listPublicChangelogs } from '../changelog.public'
import { deleteChangelog } from '../changelog.service'
import { isNull, eq, lt } from '@/lib/server/db'

// Chainable mock for `db.select().from().innerJoin()...where()` — resolves
// with the rows you provide when `.where()` is awaited.
function selectChainResolving(rows: unknown[]): unknown {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.innerJoin = () => chain
  chain.where = () => Promise.resolve(rows)
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
  mockStatusesFindMany.mockResolvedValue([])
  // Default: any `db.select(...)` returns an empty linked-post set.
  mockSelect.mockImplementation(() => selectChainResolving([]))
})

describe('getPublicChangelogById', () => {
  it('filters out soft-deleted entries (isNull deletedAt)', async () => {
    mockEntryFindFirst.mockResolvedValueOnce({
      id: 'cl_1' as ChangelogId,
      title: 'Test',
      content: '',
      contentJson: null,
      publishedAt: new Date('2026-01-01'),
    })

    await getPublicChangelogById('cl_1' as ChangelogId)

    expect(isNull).toHaveBeenCalledWith(changelogEntriesTable.deletedAt)
  })
})

describe('listPublicChangelogs', () => {
  it('filters out soft-deleted entries (isNull deletedAt)', async () => {
    mockEntryFindMany.mockResolvedValueOnce([])

    await listPublicChangelogs({})

    expect(isNull).toHaveBeenCalledWith(changelogEntriesTable.deletedAt)
  })

  it('keeps cursor pagination working when the anchor row was soft-deleted', async () => {
    // Cursor row still has its publishedAt because deleteChangelog
    // preserves it precisely so pagination has an anchor.
    mockEntryFindFirst.mockResolvedValueOnce({
      publishedAt: new Date('2026-01-01'),
    })
    mockEntryFindMany.mockResolvedValueOnce([])

    await listPublicChangelogs({ cursor: 'cl_cursor' })

    // The cursor lookup itself does NOT filter on deletedAt — it must
    // find the row even if deleted, so we keep paginating past it.
    const cursorEqCalls = vi
      .mocked(eq)
      .mock.calls.filter(
        (args) => (args[0] as unknown) === changelogEntriesTable.id && args[1] === 'cl_cursor'
      )
    expect(cursorEqCalls.length).toBe(1)

    // The pagination filter (lt publishedAt) was applied, so the user
    // doesn't fall back to the first page.
    const ltPublishedAtCalls = vi
      .mocked(lt)
      .mock.calls.filter((args) => (args[0] as unknown) === changelogEntriesTable.publishedAt)
    expect(ltPublishedAtCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('deleteChangelog', () => {
  it('sets deletedAt but preserves publishedAt so cursors stay valid', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'cl_1' }])

    await deleteChangelog('cl_1' as ChangelogId)

    const setArgs = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>
    expect(setArgs.deletedAt).toBeInstanceOf(Date)
    expect('publishedAt' in setArgs).toBe(false)
  })
})
