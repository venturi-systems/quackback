/**
 * Hook delivery idempotency table.
 *
 * Records every hook job outcome, keyed by the BullMQ job ID
 * (apps/web/src/lib/server/events/hook-idempotency.ts). A `processing` row
 * is a short lease a crashed worker's successor may take over; `completed`
 * and `failed` rows deduplicate BullMQ replays. A retryable failure deletes
 * its row so the retry delivers.
 *
 * This closes a long-standing gap where worker crashes mid-handler caused
 * BullMQ to re-run the job on the next boot — re-firing webhooks (visible
 * to customers as duplicate deliveries) and re-billing OpenAI for
 * sentiment + embedding work that already completed.
 *
 * `processedAt` lets us prune rows older than the BullMQ retention window
 * (rows for completed jobs older than 24h are useless because BullMQ has
 * forgotten the job by then).
 */
import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'

export const hookDeliveries = pgTable(
  'hook_deliveries',
  {
    /** BullMQ job ID — primary key. Format depends on the queue, but is
     *  always a string opaque to this table. */
    jobId: text('job_id').primaryKey(),
    /** Hook type that processed this job (e.g. 'webhook', 'ai'). Useful
     *  for debugging + retention sweeps that target one hook type. */
    hookType: text('hook_type').notNull(),
    /** processing (a lease), completed or failed. Added by
     *  9002_venturi_hook_delivery_outcome; existing rows read as completed. */
    outcome: text('outcome').notNull().default('completed'),
    /** Wall-clock time of the latest claim or outcome. Used for leases and pruning. */
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Prune query: DELETE WHERE processed_at < now() - interval '7 days'
    index('hook_deliveries_processed_at_idx').on(table.processedAt),
  ]
)
