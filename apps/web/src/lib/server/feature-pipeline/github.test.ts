import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { buildRequestBody, type RequestSnapshot } from './model'
vi.mock('./rate-budget', () => ({
  reserveGithubRequest: vi.fn().mockResolvedValue(undefined),
  observeGithubBudget: vi.fn().mockResolvedValue(undefined),
}))
import { recoverCreatedIssue, RecoveryReviewRequired } from './github'
const snapshot: RequestSnapshot = {
  title: 'Exact request',
  content: 'Preserve every detail',
  portalUrl: 'https://feedback.example/request',
  author: 'Requester',
  capability: 'Usage imports',
  createdAt: '2026-10-02T00:00:00Z',
  classification: 'feature request',
}
const postId = 'post_test'
const issue = {
  id: 1,
  node_id: 'I_1',
  number: 1,
  html_url: 'https://github.com/o/r/issues/1',
  state: 'open',
  labels: [],
  updated_at: '2026-10-02T00:00:00Z',
  title: snapshot.title,
  body: buildRequestBody(postId, snapshot),
  user: { type: 'Bot', login: 'request-app[bot]' },
}
const fetcher = vi.fn()
let repoId = 0
beforeEach(() => {
  repoId++
  vi.stubEnv('FEATURE_PIPELINE_TOKEN_SOCKET', '/tmp/test-only.sock')
  vi.stubGlobal('fetch', fetcher)
  fetcher.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
function responses(pages: unknown[][]) {
  fetcher.mockImplementation(async (url: string) => {
    if (url === 'http://localhost/token')
      return Response.json({
        token: 'test-only',
        repository_id: String(repoId),
        expires_at: new Date(Date.now() + 3500000).toISOString(),
      })
    return Response.json(pages.shift() ?? [])
  })
}
describe('bounded uncertain creation recovery', () => {
  it('recovers only the exact immutable request and scopes the inventory by attempt time', async () => {
    responses([
      [
        { ...issue, node_id: 'I_forged', body: issue.body + 'altered' },
        { ...issue, node_id: 'I_human', user: { type: 'User', login: 'person' } },
        issue,
      ],
    ])
    expect(
      await recoverCreatedIssue(
        'o/r',
        String(repoId),
        postId,
        snapshot,
        new Date('2026-10-02T00:02:00Z')
      )
    ).toMatchObject({ node_id: 'I_1' })
    const request = fetcher.mock.calls.find(
      ([url]) => new URL(String(url)).origin === 'https://api.github.com'
    )![0]
    expect(new URL(request).searchParams.get('since')).toBe('2026-10-02T00:00:00.000Z')
  })
  it('halts after five pages and asks for staff review instead of rescanning thousands of pages', async () => {
    responses(
      Array.from({ length: 6 }, () =>
        Array.from({ length: 100 }, () => ({ ...issue, body: 'other request' }))
      )
    )
    await expect(
      recoverCreatedIssue('o/r', String(repoId), postId, snapshot, new Date())
    ).rejects.toBeInstanceOf(RecoveryReviewRequired)
    expect(
      fetcher.mock.calls.filter(([url]) => new URL(String(url)).origin === 'https://api.github.com')
    ).toHaveLength(5)
  })
  it('holds duplicate immutable markers rather than choosing an arbitrary issue', async () => {
    responses([[issue, { ...issue, node_id: 'I_duplicate', number: 2 }]])
    await expect(
      recoverCreatedIssue('o/r', String(repoId), postId, snapshot, new Date())
    ).rejects.toBeInstanceOf(RecoveryReviewRequired)
  })
})
