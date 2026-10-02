import { createHash } from 'node:crypto'
/** Pure reconciliation rules, shared by live worker and adversarial tests. */
export const PIPELINE_STATUSES = [
  'open',
  'under_review',
  'planned',
  'in_progress',
  'complete',
  'closed',
  'declined',
  'withdrawn',
  'deferred',
  'redundant',
] as const
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number]
export interface RemoteIssue {
  id: number
  title?: string
  user?: { type: string; login: string }
  state_reason?: string | null
  node_id: string
  number: number
  html_url: string
  body: string | null
  state: 'open' | 'closed'
  labels: Array<{ name: string }>
  updated_at: string
}
export function isPipelineStatus(value: string): value is PipelineStatus {
  return (PIPELINE_STATUSES as readonly string[]).includes(value)
}
export function closedStatus(status: PipelineStatus) {
  return ['complete', 'closed', 'declined', 'withdrawn', 'redundant'].includes(status)
}
export function normalizeIssue(issue: RemoteIssue, baseline?: string | null): PipelineStatus {
  const labels = [
    ...new Set(
      issue.labels
        .map((l) => l.name)
        .filter((name) => name.startsWith('status:'))
        .map((name) => name.slice(7))
        .filter(isPipelineStatus)
    ),
  ]
  // Adding the successor label is a valid GitHub-side transition. Retire the
  // previously acknowledged label after selecting the one new designation.
  const successors = labels.filter((s) => s !== baseline)
  if (successors.length > 1) throw new Error('Multiple new status designations require review')
  const selected = successors[0] ?? (labels.length === 1 ? labels[0] : undefined)
  if (selected) {
    if (selected === baseline && issue.state === 'closed' && !closedStatus(selected)) {
      return 'closed'
    }
    if (selected === baseline && issue.state === 'open' && closedStatus(selected)) return 'open'
    return selected
  }
  if (baseline && isPipelineStatus(baseline)) {
    const expectedState = closedStatus(baseline) ? 'closed' : 'open'
    if (issue.state !== expectedState) return issue.state === 'closed' ? 'closed' : 'open'
    return baseline
  }
  // A generic close never constitutes evidence of shipment.
  return issue.state === 'closed' ? 'closed' : 'open'
}
export function reconcileStatus(
  portal: PipelineStatus,
  github: PipelineStatus,
  baselinePortal: string | null,
  baselineGithub: string | null
) {
  const portalChanged = portal !== baselinePortal
  const githubChanged = github !== baselineGithub
  const conflict = portalChanged && githubChanged && portal !== github
  return {
    status: portalChanged ? portal : githubChanged ? github : portal,
    conflict,
    reason: conflict
      ? 'concurrent_changes_portal_wins'
      : portalChanged
        ? 'portal_change'
        : 'github_change',
  }
}
export function requestMarker(postId: string) {
  return '<!-- feature-pipeline:' + postId + ' -->'
}
export interface RequestSnapshot {
  title: string
  content: string
  portalUrl: string
  author: string
  capability: string
  createdAt: string
  originEvidence?: string
  classification: 'feature request' | 'enhancement'
}
export function snapshotHash(snapshot: RequestSnapshot) {
  const canonical = JSON.stringify(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(canonical).digest('hex')
}
export function buildRequestBody(postId: string, snapshot: RequestSnapshot) {
  return [
    requestMarker(postId),
    '<!-- feature-source-sha256:' + snapshotHash(snapshot) + ' -->',
    '## Explicit request',
    snapshot.content || '(No additional description supplied.)',
    '## Source and routing context',
    '- Original title: ' + snapshot.title,
    '- Request: ' + snapshot.portalUrl,
    '- Submitted by: ' + snapshot.author,
    '- Submitted at: ' + snapshot.createdAt,
    '- Primary capability: ' + snapshot.capability,
    '- Classification: ' + snapshot.classification,
    '- Origin evidence: ' + (snapshot.originEvidence ?? 'Recorded in the original request.'),
    '## Inferred implementation considerations (validate before implementation)',
    '- Confirm intended behavior, affected users, permissions, and failure cases from the source request.',
    '- Inspect the governing PRD and engineering specification; record missing requirements before implementation.',
    '- Preserve existing access controls, data integrity, and accessibility on affected surfaces.',
    '## Acceptance and unresolved details',
    '- Demonstrate the requested behavior with evidence linked to the governing requirement.',
    '- Record assumptions and unresolved product decisions explicitly; do not treat inferred details as customer commitments.',
    '- Keep this issue and the feedback request status synchronized.',
  ].join('\n\n')
}
