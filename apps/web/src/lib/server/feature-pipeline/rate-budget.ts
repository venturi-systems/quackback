import { db, sql } from '@/lib/server/db'

// Shared across replicas and repositories using the same App installation.
// Reserve most of the installation's quota for other consumers.
export const REQUESTS_PER_MINUTE = 30
export class GithubBudgetError extends Error {
  constructor(public readonly retryAt: Date) {
    super('GitHub request budget paused; synchronization will retry after ' + retryAt.toISOString())
  }
}
export async function reserveGithubRequest() {
  const rows = await db.execute(sql`UPDATE feature_pipeline_api_budget SET
    requests=CASE WHEN window_started_at<=now()-interval '1 minute' THEN 1 ELSE requests+1 END,
    window_started_at=CASE WHEN window_started_at<=now()-interval '1 minute' THEN now() ELSE window_started_at END
    WHERE id=1 AND (paused_until IS NULL OR paused_until<=now())
      AND (window_started_at<=now()-interval '1 minute' OR requests<${REQUESTS_PER_MINUTE})
    RETURNING id`)
  if (rows.length) return
  const state = await db.execute(
    sql`SELECT window_started_at,paused_until FROM feature_pipeline_api_budget WHERE id=1`
  )
  if (!state[0]) throw new Error('Shared GitHub request budget is not initialized')
  throw new GithubBudgetError(
    new Date(
      Math.max(
        Date.now() + 1000,
        new Date(String(state[0].window_started_at)).getTime() + 60_000,
        state[0].paused_until ? new Date(String(state[0].paused_until)).getTime() : 0
      )
    )
  )
}
export function rateLimitRetryAt(status: number, headers: Headers, now = Date.now()): Date | null {
  const remaining = headers.get('x-ratelimit-remaining')
  const retry = headers.get('retry-after')
  const exhausted = remaining !== null && Number(remaining) <= 50
  if (status !== 429 && !(status === 403 && retry) && !exhausted) return null
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000
  const retrySeconds = retry ? Number(retry) : NaN
  const retryDate = retry && !Number.isFinite(retrySeconds) ? Date.parse(retry) : NaN
  return new Date(
    Math.min(
      now + 86_400_000,
      Math.max(
        now + 60_000,
        Number.isFinite(reset) ? reset : 0,
        Number.isFinite(retrySeconds) ? now + retrySeconds * 1000 : 0,
        Number.isFinite(retryDate) ? retryDate : 0
      )
    )
  )
}
export async function observeGithubBudget(response: Response) {
  const retryAt = rateLimitRetryAt(response.status, response.headers)
  if (!retryAt) return
  await db.execute(sql`UPDATE feature_pipeline_api_budget SET
    paused_until=greatest(COALESCE(paused_until,now()),${retryAt.toISOString()}::timestamptz)
    WHERE id=1`)
  if (!response.ok) throw new GithubBudgetError(retryAt)
}
