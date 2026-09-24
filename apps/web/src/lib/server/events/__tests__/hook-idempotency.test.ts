/**
 * Hook idempotency unit tests (outcome-aware lease, upstream 01cd9b96b A1).
 *
 * Exercises the claim/complete/fail/release primitives with a mocked DB. The
 * lease semantics themselves (a fresh processing row blocks, a stale one is
 * taken over, completed and failed rows block) live in the INSERT ... ON
 * CONFLICT statement, asserted here by its shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  execute: vi.fn(),
  updateSet: vi.fn(),
  deleted: vi.fn(),
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    execute: (q: unknown) => m.execute(q),
    update: () => ({
      set: (v: unknown) => {
        m.updateSet(v)
        return { where: async () => undefined }
      },
    }),
    delete: () => ({
      where: async (cond: unknown) => {
        m.deleted(cond)
      },
    }),
  },
  hookDeliveries: { jobId: 'job_id', outcome: 'outcome', processedAt: 'processed_at' },
  eq: (col: string, val: unknown) => ({ col, val }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'),
    values,
  }),
}))

import {
  claimHookDelivery,
  completeHookDelivery,
  failHookDelivery,
  releaseHookDelivery,
  HOOK_LEASE_TIMEOUT,
} from '../hook-idempotency'

beforeEach(() => {
  m.execute.mockReset()
  m.updateSet.mockReset()
  m.deleted.mockReset()
})

describe('claimHookDelivery', () => {
  it('returns true when the upsert returns the row (new claim or stale lease)', async () => {
    m.execute.mockResolvedValueOnce([{ job_id: 'job_1' }])
    expect(await claimHookDelivery('job_1', 'webhook')).toBe(true)
    const q = m.execute.mock.calls[0][0] as { text: string; values: unknown[] }
    expect(q.values).toEqual(['job_1', 'webhook', HOOK_LEASE_TIMEOUT])
    expect(q.text).toContain("'processing'")
    expect(q.text).toContain('ON CONFLICT (job_id) DO UPDATE')
    // Only a stale processing lease is taken over; completed/failed rows block.
    expect(q.text).toContain("WHERE hook_deliveries.outcome = 'processing'")
  })

  it('returns false when another worker holds or finished the job', async () => {
    m.execute.mockResolvedValueOnce([])
    expect(await claimHookDelivery('job_1', 'webhook')).toBe(false)
  })

  it('passes through for missing jobId (test/ad-hoc paths)', async () => {
    expect(await claimHookDelivery(undefined, 'webhook')).toBe(true)
    expect(m.execute).not.toHaveBeenCalled()
  })
})

describe('lease outcomes', () => {
  it('records completion and terminal failure', async () => {
    await completeHookDelivery('job_1')
    await failHookDelivery('job_2')
    expect(m.updateSet.mock.calls.map((c) => (c[0] as { outcome: string }).outcome)).toEqual([
      'completed',
      'failed',
    ])
  })

  it('releases a claim by deleting its row', async () => {
    await releaseHookDelivery('job_3')
    expect(m.deleted).toHaveBeenCalledWith({ col: 'job_id', val: 'job_3' })
  })

  it('does nothing without a job id', async () => {
    await completeHookDelivery(undefined)
    await failHookDelivery(undefined)
    await releaseHookDelivery(undefined)
    expect(m.updateSet).not.toHaveBeenCalled()
    expect(m.deleted).not.toHaveBeenCalled()
  })
})
