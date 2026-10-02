import { describe, expect, it } from 'vitest'
import {
  buildRequestBody,
  normalizeIssue,
  reconcileStatus,
  requestMarker,
  type RemoteIssue,
} from './model'
const issue = (state: 'open' | 'closed', labels: string[]): RemoteIssue => ({
  id: 12,
  node_id: 'I_global_id',
  number: 42,
  html_url: 'https://github.com/o/r/issues/42',
  body: '',
  state,
  labels: labels.map((name) => ({ name })),
  updated_at: '2026-10-02T00:00:00Z',
})
describe('feature pipeline status contract', () => {
  for (const status of ['declined', 'withdrawn', 'deferred', 'redundant'] as const) {
    it('propagates ' + status + ' in both directions', () => {
      expect(reconcileStatus(status, 'open', 'open', 'open').status).toBe(status)
      expect(reconcileStatus('open', status, 'open', 'open').status).toBe(status)
      expect(normalizeIssue(issue('open', ['status:open', 'status:' + status]), 'open')).toBe(
        status
      )
    })
  }
  it('retains a deterministic, auditable conflict', () => {
    expect(reconcileStatus('withdrawn', 'declined', 'open', 'open')).toEqual({
      status: 'withdrawn',
      conflict: true,
      reason: 'concurrent_changes_portal_wins',
    })
  })
  it('does not infer shipment from a generic closure', () => {
    expect(normalizeIssue(issue('closed', []))).toBe('closed')
    expect(normalizeIssue(issue('closed', ['status:open']), 'open')).toBe('closed')
  })
  it('rejects two competing new dispositions', () => {
    expect(() =>
      normalizeIssue(issue('closed', ['status:declined', 'status:withdrawn']), 'open')
    ).toThrow()
  })
  it('preserves long Markdown, code, and Unicode with a stable recovery marker', () => {
    const content =
      '# Request\n\n' + 'Useful detail. '.repeat(350) + '\n\n```ts\nconst label = "Δ 東京"\n```'
    const body = buildRequestBody('post_test', {
      title: 'Long request',
      content,
      author: 'Contributor',
      capability: 'Data import',
      portalUrl: 'https://feedback.example/b/features/posts/post_test',
      createdAt: '2026-10-02T00:00:00Z',
      classification: 'feature request',
    })
    expect(body).toContain(content)
    expect(body).toContain(requestMarker('post_test'))
    expect(body).toContain(
      'Inferred implementation considerations (validate before implementation)'
    )
  })
})
