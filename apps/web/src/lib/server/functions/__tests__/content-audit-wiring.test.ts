/**
 * Audit coverage for tag, roadmap and changelog changes made in the admin UI
 * (landing-page#2309, extras report section 1). Each mutation writes its own
 * row, with the value before the change where there is one, and publishing a
 * changelog entry writes a `changelog.published` row as well.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  recordAuditSafely: vi.fn(),
  requireAuth: vi.fn(),
  tags: {
    listTags: vi.fn(),
    getTagById: vi.fn(),
    createTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn(),
  },
  roadmaps: {
    addPostToRoadmap: vi.fn(),
    createRoadmap: vi.fn(),
    deleteRoadmap: vi.fn(),
    getRoadmap: vi.fn(),
    listRoadmaps: vi.fn(),
    removePostFromRoadmap: vi.fn(),
    reorderRoadmaps: vi.fn(),
    updateRoadmap: vi.fn(),
  },
  changelog: {
    createChangelog: vi.fn(),
    updateChangelog: vi.fn(),
    deleteChangelog: vi.fn(),
    getChangelogById: vi.fn(),
  },
}))

vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    const chain = {
      validator() {
        return chain
      },
      handler(fn: unknown) {
        return fn
      },
    }
    return chain
  },
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({ requireAuth: hoisted.requireAuth }))
vi.mock('@/lib/server/functions/portal-access', () => ({
  resolvePortalAccessForRequest: vi.fn(),
}))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))
vi.mock('@/lib/server/audit/audit-safe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/audit/audit-safe')>()),
  recordAuditSafely: hoisted.recordAuditSafely,
}))
vi.mock('@/lib/server/domains/tags/tag.service', () => hoisted.tags)
vi.mock('@/lib/server/domains/roadmaps/roadmap.service', () => hoisted.roadmaps)
vi.mock('@/lib/server/domains/roadmaps/roadmap.query', () => ({ getRoadmapPosts: vi.fn() }))
vi.mock('@/lib/server/domains/changelog/changelog.service', () => hoisted.changelog)
vi.mock('@/lib/server/domains/changelog/changelog.query', () => ({
  listChangelogs: vi.fn(),
  searchShippedPosts: vi.fn(),
}))
vi.mock('@/lib/server/domains/changelog/changelog.public', () => ({
  getPublicChangelogById: vi.fn(),
  listPublicChangelogs: vi.fn(),
}))

import * as tagFns from '../tags'
import * as roadmapFns from '../roadmaps'
import * as changelogFns from '../changelog'

type Handler = (args: { data: Record<string, unknown> }) => Promise<unknown>
const call = (fn: unknown, data: Record<string, unknown>) => (fn as Handler)({ data })

function rows() {
  return hoisted.recordAuditSafely.mock.calls.map(([input]) => input as Record<string, unknown>)
}

const TAG = { id: 'tag_1', name: 'Bug', color: '#ef4444', description: null }
const ROADMAP = {
  id: 'roadmap_1',
  name: 'Q1',
  slug: 'q1',
  description: null,
  isPublic: true,
  position: 0,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
}
const ENTRY = {
  id: 'changelog_1',
  title: 'v2',
  content: 'body',
  publishedAt: null as Date | null,
  displayDate: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({
    user: { id: 'user_1', email: 'member@example.com', name: 'Member' },
    principal: { id: 'principal_1', role: 'member', type: 'user' },
  })
  hoisted.tags.getTagById.mockResolvedValue(TAG)
  hoisted.tags.createTag.mockResolvedValue(TAG)
  hoisted.tags.updateTag.mockResolvedValue({ ...TAG, name: 'Defect' })
  hoisted.roadmaps.getRoadmap.mockResolvedValue(ROADMAP)
  hoisted.roadmaps.createRoadmap.mockResolvedValue(ROADMAP)
  hoisted.roadmaps.updateRoadmap.mockResolvedValue({ ...ROADMAP, isPublic: false })
  hoisted.roadmaps.deleteRoadmap.mockResolvedValue(undefined)
  hoisted.changelog.getChangelogById.mockResolvedValue(ENTRY)
  hoisted.changelog.createChangelog.mockResolvedValue(ENTRY)
  hoisted.changelog.updateChangelog.mockResolvedValue(ENTRY)
})

describe('tag changes are audited', () => {
  it('records created, updated and deleted with before and after', async () => {
    await call(tagFns.createTagFn, { name: 'Bug', color: '#ef4444' })
    await call(tagFns.updateTagFn, { id: 'tag_1', name: 'Defect' })
    await call(tagFns.deleteTagFn, { id: 'tag_1' })
    expect(rows()).toEqual([
      expect.objectContaining({
        event: 'tag.created',
        target: { type: 'tag', id: 'tag_1' },
        after: { name: 'Bug', color: '#ef4444', description: null },
      }),
      expect.objectContaining({
        event: 'tag.updated',
        before: { name: 'Bug', color: '#ef4444', description: null },
        after: { name: 'Defect', color: '#ef4444', description: null },
      }),
      expect.objectContaining({
        event: 'tag.deleted',
        target: { type: 'tag', id: 'tag_1' },
        before: { name: 'Bug', color: '#ef4444', description: null },
      }),
    ])
    for (const row of rows()) expect(row.actor).toMatchObject({ userId: 'user_1' })
  })
})

describe('roadmap changes are audited', () => {
  it('records every roadmap mutation', async () => {
    await call(roadmapFns.createRoadmapFn, { name: 'Q1', slug: 'q1', isPublic: true })
    await call(roadmapFns.updateRoadmapFn, { id: 'roadmap_1', isPublic: false })
    await call(roadmapFns.addPostToRoadmapFn, { roadmapId: 'roadmap_1', postId: 'post_1' })
    await call(roadmapFns.removePostFromRoadmapFn, { roadmapId: 'roadmap_1', postId: 'post_1' })
    await call(roadmapFns.reorderRoadmapsFn, { roadmapIds: ['roadmap_2', 'roadmap_1'] })
    await call(roadmapFns.deleteRoadmapFn, { id: 'roadmap_1' })
    expect(rows().map((row) => row.event)).toEqual([
      'roadmap.created',
      'roadmap.updated',
      'roadmap.post.added',
      'roadmap.post.removed',
      'roadmap.reordered',
      'roadmap.deleted',
    ])
    expect(rows()[1]).toMatchObject({
      before: { isPublic: true },
      after: { isPublic: false },
    })
    expect(rows()[2]).toMatchObject({ after: { postId: 'post_1' } })
    expect(rows()[4]).toMatchObject({ after: { order: ['roadmap_2', 'roadmap_1'] } })
  })

  it('records nothing when the change fails', async () => {
    hoisted.roadmaps.deleteRoadmap.mockRejectedValue(new Error('not found'))
    await expect(call(roadmapFns.deleteRoadmapFn, { id: 'roadmap_1' })).rejects.toThrow()
    expect(rows()).toEqual([])
  })
})

describe('changelog changes are audited', () => {
  it('records a draft as created only', async () => {
    await call(changelogFns.createChangelogFn, {
      title: 'v2',
      content: 'body',
      publishState: { type: 'draft' },
    })
    expect(rows().map((row) => row.event)).toEqual(['changelog.created'])
  })

  it('records publishing a draft as updated and published', async () => {
    hoisted.changelog.updateChangelog.mockResolvedValue({
      ...ENTRY,
      publishedAt: new Date('2026-09-02T00:00:00.000Z'),
    })
    await call(changelogFns.updateChangelogFn, {
      id: 'changelog_1',
      publishState: { type: 'published' },
    })
    expect(rows().map((row) => row.event)).toEqual(['changelog.updated', 'changelog.published'])
    expect(rows()[1]).toMatchObject({
      before: { publishedAt: null },
      after: { publishedAt: '2026-09-02T00:00:00.000Z' },
    })
  })

  it('records a deletion with the entry as it was', async () => {
    await call(changelogFns.deleteChangelogFn, { id: 'changelog_1' })
    expect(rows()).toEqual([
      expect.objectContaining({
        event: 'changelog.deleted',
        target: { type: 'changelog', id: 'changelog_1' },
        before: { title: 'v2', publishedAt: null, displayDate: null },
      }),
    ])
  })
})
