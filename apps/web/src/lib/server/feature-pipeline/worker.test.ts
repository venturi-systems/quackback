import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { snapshotHash } from './model'

const h = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  issue: {} as Record<string, unknown>,
  failure: '' as string,
  failed: false,
  posts: 0,
}))
vi.mock('@/lib/server/logger', () => ({ logger: { child: () => ({ error: vi.fn() }) } }))
vi.mock('@/lib/server/feature-pipeline/status-effects', () => ({
  applyPipelineStatus: vi.fn().mockResolvedValue({ changed: false, eventId: null }),
  dispatchPendingPipelineStatusEvents: vi.fn().mockResolvedValue({ delivered: 0, failed: 0 }),
}))
vi.mock('@/lib/server/db', () => {
  type Query = { text: string; values: unknown[] }
  const execute = async (query: Query) => {
    const text = query.text
    if (text.includes('WITH due AS')) return [{ post_id: h.row.post_id, phase: h.row.phase }]
    if (text.includes('SELECT l.*,s.slug')) return [{ ...h.row }]
    if (text.includes('SET recovery_attempts=recovery_attempts+1'))
      h.row.recovery_attempts = Number(h.row.recovery_attempts) + 1
    if (text.includes('phase=CASE WHEN') && query.values[1]) h.row.phase = 'held'
    if (text.includes("SET phase='creating'")) {
      h.row.phase = 'creating'
      h.row.attempted_at = new Date()
      return []
    }
    if (text.includes("SET phase='linked'")) {
      if (h.failure === 'commit' && !h.failed) {
        h.failed = true
        throw new Error('DB commit unavailable')
      }
      h.row.phase = 'linked'
      h.row.issue_node_id = query.values[0]
      h.row.issue_number = query.values[1]
      return []
    }
    if (text.includes('SELECT s.slug FROM posts')) return [{ slug: h.row.portal_status }]
    if (text.includes('SELECT id FROM post_statuses'))
      return [{ id: '00000000-0000-4000-8000-000000000002' }]
    if (text.includes('SET baseline_portal=')) {
      h.row.baseline_portal = query.values[0]
      h.row.baseline_github = query.values[1]
      return []
    }
    return []
  }
  const db = {
    execute,
    transaction: async (fn: (tx: { execute: typeof execute }) => unknown) => fn({ execute }),
  }
  return {
    db,
    sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({ text: parts.join('?'), values }),
  }
})
vi.mock('@/lib/server/events/process', () => ({
  garbageCollectDurableHookJobs: vi.fn().mockResolvedValue({ removed: 0, redacted: 0 }),
}))
vi.mock('./rate-budget', async (original) => ({
  ...(await original<typeof import('./rate-budget')>()),
  reserveGithubRequest: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./github', () => ({
  RecoveryReviewRequired: class extends Error {},
  verifyRepository: vi.fn().mockResolvedValue(undefined),
  ensureLabel: vi.fn().mockResolvedValue(undefined),
  recoverCreatedIssue: vi.fn(async () => (h.posts ? h.issue : null)),
  githubRequest: vi.fn(async (_repo: string, _id: string, _path: string, method?: string) => {
    if (method === 'POST') {
      h.posts++
      if (h.failure === 'response' && !h.failed) {
        h.failed = true
        throw new Error('Response lost after provider committed')
      }
    }
    return h.issue
  }),
  setIssueStatus: vi.fn(async (_repo: string, _id: string, _issue: unknown, status: string) => {
    h.issue.labels = [{ name: 'status:' + status }]
  }),
}))

describe('durable issue creation under partial failure', () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.stubEnv('FEATURE_PIPELINE_ENABLED', 'true')
    h.posts = 0
    h.failed = false
    h.failure = ''
    const snapshot = {
      title: 'Exact request',
      content: 'Full body',
      author: 'Requester',
      portalUrl: 'https://feedback.example/request',
      capability: 'Cost attribution',
      createdAt: '2026-10-02T00:00:00Z',
      classification: 'feature request' as const,
    }
    h.row = {
      post_id: '00000000-0000-4000-8000-000000000001',
      repository: 'organization/product',
      repository_id: '123',
      phase: 'pending',
      issue_node_id: null,
      issue_number: null,
      attempted_at: null,
      recovery_attempts: 0,
      source_snapshot: snapshot,
      source_sha256: snapshotHash(snapshot),
      classification: 'feature request',
      portal_status: 'open',
      baseline_portal: null,
      baseline_github: null,
      moderation_state: 'published',
      deleted_at: null,
    }
    h.issue = {
      id: 7,
      node_id: 'I_immutable',
      number: 42,
      html_url: 'https://github.com/organization/product/issues/42',
      title: snapshot.title,
      state: 'open',
      labels: [{ name: 'status:open' }],
      body: 'stored provider body',
      updated_at: '2026-10-02T00:00:00Z',
    }
  })
  it.each(['response', 'commit'])(
    'recovers without a second POST after %s loss',
    async (failure) => {
      h.failure = failure
      const { runFeaturePipeline } = await import('./worker')
      await runFeaturePipeline()
      expect(h.row.phase).toBe('creating')
      expect(h.row.attempted_at).toBeInstanceOf(Date)
      expect(h.posts).toBe(1)
      await runFeaturePipeline()
      expect(h.row.phase).toBe('linked')
      expect(h.row.issue_node_id).toBe('I_immutable')
      expect(h.posts).toBe(1)
    }
  )
  it('holds uncertain creation after three completed scans without another POST', async () => {
    h.row.attempted_at = new Date()
    h.row.phase = 'creating'
    const { runFeaturePipeline } = await import('./worker')
    await runFeaturePipeline()
    await runFeaturePipeline()
    await runFeaturePipeline()
    expect(h.posts).toBe(0)
    expect(h.row.recovery_attempts).toBe(3)
    expect(h.row.phase).toBe('held')
  })
  it('leaves known pre-POST budget failure eligible for a first creation', async () => {
    const { reserveGithubRequest, GithubBudgetError } = await import('./rate-budget')
    vi.mocked(reserveGithubRequest).mockRejectedValueOnce(
      new GithubBudgetError(new Date(Date.now() + 60000))
    )
    const { runFeaturePipeline } = await import('./worker')
    await runFeaturePipeline()
    expect(h.row.attempted_at).toBeNull()
    expect(h.posts).toBe(0)
    await runFeaturePipeline()
    expect(h.posts).toBe(1)
  })
  it('does not create GitHub issues for held moderation', async () => {
    h.row.moderation_state = 'pending'
    const { runFeaturePipeline } = await import('./worker')
    await runFeaturePipeline()
    expect(h.posts).toBe(0)
  })
})
