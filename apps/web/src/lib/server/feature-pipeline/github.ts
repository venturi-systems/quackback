import { reserveGithubRequest, observeGithubBudget } from './rate-budget'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import {
  closedStatus,
  PIPELINE_STATUSES,
  buildRequestBody,
  type RequestSnapshot,
  type RemoteIssue,
  type PipelineStatus,
} from './model'

const tokens = new Map<string, { token: string; expires: number }>()
const lambda = new LambdaClient({})
async function tokenFor(repositoryId: string, refresh = false): Promise<string> {
  const cached = tokens.get(repositoryId)
  if (!refresh && cached && cached.expires > Date.now() + 120_000) return cached.token
  const socket = process.env.FEATURE_PIPELINE_TOKEN_SOCKET
  let response: { token: string; expires_at: string; repository_id: string }
  if (socket) {
    const result = await fetch('http://localhost/token', {
      method: 'POST',
      unix: socket,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository_id: repositoryId }),
      signal: AbortSignal.timeout(25_000),
    } as RequestInit & { unix: string })
    if (!result.ok) throw new Error('Scoped issue credential bridge unavailable')
    response = await result.json()
  } else {
    const functionName = process.env.FEATURE_PIPELINE_TOKEN_BROKER
    if (!functionName) throw new Error('Feature pipeline token broker is not configured')
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(JSON.stringify({ repository_id: repositoryId })),
      })
    )
    if (result.FunctionError || !result.Payload)
      throw new Error('Feature pipeline token broker failed')
    response = JSON.parse(Buffer.from(result.Payload).toString())
  }
  const expires = Date.parse(response.expires_at)
  if (
    response.repository_id !== repositoryId ||
    typeof response.token !== 'string' ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 3_600_000
  ) {
    throw new Error('Invalid repository-scoped broker response')
  }
  tokens.set(repositoryId, { token: response.token, expires })
  return response.token
}
export async function githubRequest<T>(
  repository: string,
  repositoryId: string,
  path: string,
  method = 'GET',
  body?: unknown,
  reserved = false
): Promise<T> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository')
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await tokenFor(repositoryId, attempt === 1)
    if (!reserved || attempt > 0) await reserveGithubRequest()
    const result = await fetch('https://api.github.com/repos/' + repository + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    })
    await observeGithubBudget(result)
    if (result.status === 401 && attempt === 0) continue
    if (result.status === 204) return undefined as T
    if (!result.ok) throw new Error('GitHub request failed: ' + result.status)
    return (await result.json()) as T
  }
  throw new Error('GitHub authorization failed')
}
export async function verifyRepository(repository: string, repositoryId: string) {
  const repo = await githubRequest<{
    id: number
    archived: boolean
    has_issues: boolean
    private: boolean
  }>(repository, repositoryId, '')
  if (String(repo.id) !== repositoryId || repo.archived || !repo.has_issues) {
    throw new Error('Repository identity changed or issue tracker is not writable')
  }
  // This deployment routes company feedback into private trackers. Public
  // forks use an explicit private tracker proxy, configured server-side.
  if (!repo.private) throw new Error('A private implementation tracker is required')
}
export async function ensureLabel(repository: string, repositoryId: string, name: string) {
  try {
    await githubRequest(repository, repositoryId, '/labels/' + encodeURIComponent(name))
  } catch (error) {
    if (!(error instanceof Error) || !error.message.endsWith(': 404')) throw error
    await githubRequest(repository, repositoryId, '/labels', 'POST', {
      name,
      color: name.startsWith('status:') ? '6b7280' : 'a2eeef',
      description: name.startsWith('status:')
        ? 'Synchronized request disposition'
        : 'Request origin classification',
    })
  }
}
export class RecoveryReviewRequired extends Error {}
export async function recoverCreatedIssue(
  repository: string,
  repositoryId: string,
  postId: string,
  snapshot: RequestSnapshot,
  attemptedAt: Date
) {
  const expectedBody = buildRequestBody(postId, snapshot)
  const found: RemoteIssue[] = []
  for (let page = 1; ; page++) {
    const issues = await githubRequest<Array<RemoteIssue & { pull_request?: unknown }>>(
      repository,
      repositoryId,
      '/issues?state=all&sort=created&direction=desc&per_page=100&since=' +
        encodeURIComponent(new Date(attemptedAt.getTime() - 120_000).toISOString()) +
        '&page=' +
        page
    )
    found.push(
      ...issues.filter(
        (issue) =>
          !issue.pull_request &&
          issue.user?.type === 'Bot' &&
          issue.title === snapshot.title &&
          issue.body === expectedBody
      )
    )
    if (issues.length < 100) break
    if (page >= 5)
      throw new RecoveryReviewRequired('Recovery exceeded 500 recent issues; staff review required')
  }
  if (found.length > 1)
    throw new RecoveryReviewRequired(
      'Multiple remote issues carry this immutable request marker; staff review required'
    )
  return found[0] ?? null
}
export async function setIssueStatus(
  repository: string,
  repositoryId: string,
  issue: RemoteIssue,
  status: PipelineStatus
) {
  const label = 'status:' + status
  await ensureLabel(repository, repositoryId, label)
  // Add/remove exact managed labels; never replace unrelated labels.
  if (!issue.labels.some((l) => l.name === label)) {
    await githubRequest(repository, repositoryId, '/issues/' + issue.number + '/labels', 'POST', {
      labels: [label],
    })
  }
  for (const old of issue.labels) {
    if (old.name !== label && PIPELINE_STATUSES.some((s) => old.name === 'status:' + s)) {
      try {
        await githubRequest(
          repository,
          repositoryId,
          '/issues/' + issue.number + '/labels/' + encodeURIComponent(old.name),
          'DELETE'
        )
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith(': 404')) throw error
      }
    }
  }
  await githubRequest(repository, repositoryId, '/issues/' + issue.number, 'PATCH', {
    state: closedStatus(status) ? 'closed' : 'open',
    ...(status === 'complete'
      ? { state_reason: 'completed' }
      : ['declined', 'withdrawn', 'redundant'].includes(status)
        ? { state_reason: 'not_planned' }
        : {}),
  })
}
