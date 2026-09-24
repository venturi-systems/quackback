import { describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { listPublicPostsSchema } from '@/lib/shared/schemas/list-filters'

// DEF-45: a hand-made `/_serverFn/` call reaches these validators without the
// route, so each GET input takes only what its query accepts. An id column
// throws on anything but a TypeID, and Postgres rejects a NUL in text; either
// would fail the query instead of the validator.

type InputSchema = { safeParse(value: unknown): { success: boolean } }

const { inputs } = vi.hoisted(() => ({ inputs: new Map<unknown, InputSchema | undefined>() }))

vi.mock('@tanstack/react-start', () => ({
  // workspace.ts getSettings is server-only (createServerOnlyFn).
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    let input: InputSchema | undefined
    const chain = {
      validator(schema: InputSchema) {
        input = schema
        return chain
      },
      handler(fn: unknown) {
        inputs.set(fn, input)
        return fn
      },
    }
    return chain
  },
}))
vi.mock('@/lib/server/domains/posts/post.public', () => ({
  listPublicPosts: vi.fn(),
  getAllUserVotedPostIds: vi.fn(),
}))
vi.mock('../portal-access', () => ({ resolvePortalAccessForRequest: vi.fn() }))
vi.mock('../auth-helpers', () => ({
  getOptionalAuth: vi.fn(),
  policyActorFromAuth: vi.fn(),
  requireAuth: vi.fn(),
  hasAuthCredentials: vi.fn(),
}))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))
import {
  findSimilarPostsFn,
  getPostPermissionsFn,
  getPublicRoadmapPostsFn,
  getRoadmapPostsByStatusFn,
  getVoteSidebarDataFn,
  listPublicPostsFn,
} from '../public-posts'

const NUL = '\u0000'
const POST = generateId('post')
const ROADMAP = generateId('roadmap')
const STATUS = generateId('status')

function inputOf(fn: unknown): InputSchema {
  const schema = inputs.get(fn)
  if (!schema) throw new Error('server function has no validator')
  return schema
}

describe('public-posts.ts GET inputs (DEF-45)', () => {
  it('listPublicPostsFn validates with the shared list schema', () => {
    expect(inputOf(listPublicPostsFn)).toBe(listPublicPostsSchema)
  })

  it.each<[name: string, fn: unknown, accepted: unknown, refused: unknown[]]>([
    [
      'getPostPermissionsFn',
      getPostPermissionsFn,
      { postId: POST },
      [{ postId: 'post_1' }, { postId: generateId('board') }, { postId: `${POST}${NUL}` }],
    ],
    [
      'getVoteSidebarDataFn',
      getVoteSidebarDataFn,
      { postId: POST },
      [{ postId: 'post_1' }, { postId: `${POST}${NUL}` }],
    ],
    [
      'getPublicRoadmapPostsFn',
      getPublicRoadmapPostsFn,
      { roadmapId: ROADMAP, statusId: STATUS, limit: 20, offset: 40 },
      [
        { roadmapId: 'roadmap_foo' },
        { roadmapId: ROADMAP, statusId: 'in-progress' },
        { roadmapId: STATUS },
      ],
    ],
    [
      'getRoadmapPostsByStatusFn',
      getRoadmapPostsByStatusFn,
      { statusId: STATUS, page: 2, limit: 10 },
      [{ statusId: 'in-progress' }, { statusId: `${STATUS}${NUL}` }],
    ],
    [
      'findSimilarPostsFn',
      findSimilarPostsFn,
      { title: 'Dark mode', limit: 5 },
      [{ title: `Dark${NUL}mode` }, { title: NUL.repeat(3) }, { title: 'ab' }],
    ],
  ])('%s takes what the app sends and refuses the rest', (_name, fn, ok, refused) => {
    const schema = inputOf(fn)
    expect(schema.safeParse(ok).success).toBe(true)
    for (const value of refused) {
      expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    }
  })
})
