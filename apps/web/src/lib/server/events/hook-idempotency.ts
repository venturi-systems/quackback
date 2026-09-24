/**
 * Hook delivery idempotency.
 *
 * BullMQ retries on worker crashes — if a hook handler does its
 * side-effect (HTTP POST, OpenAI call, DB write) but crashes before
 * acking the job, BullMQ will re-run the handler on next boot.
 *
 * This module records an outcome-aware lease for each (jobId, hookType)
 * in `hook_deliveries` (back-ported from upstream QuackbackIO/quackback
 * 01cd9b96b, A1):
 *
 *  - `claimHookDelivery` inserts a `processing` row, or takes over a
 *    `processing` row whose lease is older than 5 minutes (the worker that
 *    held it crashed). It returns false for a `completed` or `failed` row,
 *    or a fresh `processing` row another worker holds.
 *  - `completeHookDelivery` / `failHookDelivery` record the outcome; both
 *    rows stay as durable dedupe records for BullMQ replays.
 *  - `releaseHookDelivery` deletes the claim after a RETRYABLE failure, so
 *    BullMQ's next attempt (same job id) actually performs the delivery.
 *    Before this, a retryable failure left the claim in place and every retry
 *    returned early as a "duplicate": delivery was silently at-most-once.
 *
 * The race is "first writer wins": the upsert is atomic in PG, so if two
 * workers ever process the same jobId in parallel (split-brain during
 * failover, e.g.) only one will succeed.
 */

import { db, hookDeliveries, eq, sql } from '@/lib/server/db'

/** A `processing` lease older than this belongs to a crashed worker. */
export const HOOK_LEASE_TIMEOUT = '5 minutes'

/**
 * Try to claim a hook delivery for a job. Returns true when this worker may
 * perform the side effect; false when the job already completed or failed,
 * or another worker holds a fresh lease.
 *
 * Falsy/empty jobIds short-circuit to true so callers without a stable
 * job ID (e.g. unit tests, ad-hoc dispatches) keep their old behaviour.
 */
export async function claimHookDelivery(
  jobId: string | undefined,
  hookType: string
): Promise<boolean> {
  if (!jobId) return true

  const result = await db.execute<{ job_id: string }>(sql`
    INSERT INTO hook_deliveries (job_id, hook_type, outcome, processed_at)
    VALUES (${jobId}, ${hookType}, 'processing', now())
    ON CONFLICT (job_id) DO UPDATE
      SET hook_type = excluded.hook_type,
          outcome = 'processing',
          processed_at = now()
      WHERE hook_deliveries.outcome = 'processing'
        AND hook_deliveries.processed_at < now() - ${HOOK_LEASE_TIMEOUT}::interval
    RETURNING job_id
  `)

  return Array.from(result as Iterable<{ job_id: string }>).length > 0
}

/** Record a successful side effect; the row deduplicates later replays. */
export async function completeHookDelivery(jobId: string | undefined): Promise<void> {
  if (!jobId) return
  await db
    .update(hookDeliveries)
    .set({ outcome: 'completed', processedAt: new Date() })
    .where(eq(hookDeliveries.jobId, jobId))
}

/** Record a terminal failure; the row stops replays from retrying it. */
export async function failHookDelivery(jobId: string | undefined): Promise<void> {
  if (!jobId) return
  await db
    .update(hookDeliveries)
    .set({ outcome: 'failed', processedAt: new Date() })
    .where(eq(hookDeliveries.jobId, jobId))
}

/**
 * Release a claim after a retryable failure so BullMQ's next attempt performs
 * the delivery. Terminal failures and successes keep the row.
 */
export async function releaseHookDelivery(jobId: string | undefined): Promise<void> {
  if (!jobId) return
  await db.delete(hookDeliveries).where(eq(hookDeliveries.jobId, jobId))
}
