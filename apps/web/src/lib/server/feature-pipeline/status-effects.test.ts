import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { fromUuid } from '@quackback/ids'

const execute = vi.fn()
const transaction = vi.fn()
const processEvent = vi.fn()
vi.mock('@/lib/server/db', async () => {
  const { sql } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')
  return {
    db: { execute, transaction },
    sql,
    auditLog: 'native-audit',
    postActivity: 'native-activity',
  }
})
vi.mock('@/lib/server/events/process', () => ({ processEvent }))

const { applyPipelineStatus, dispatchPendingPipelineStatusEvents } =
  await import('./status-effects')
const postUuid = '00000000-0000-4000-8000-000000000001'
const boardUuid = '00000000-0000-4000-8000-000000000002'
const oldStatus = '00000000-0000-4000-8000-000000000003'
const newStatus = '00000000-0000-4000-8000-000000000004'
const eventId = '00000000-0000-4000-8000-000000000005'
const dialect = new PgDialect()
const query = (value: SQL) => dialect.sqlToQuery(value)
const input = {
  postId: fromUuid('post', postUuid),
  expectedStatusSlug: 'open' as const,
  targetStatusSlug: 'declined' as const,
  github: { repositoryId: '123', issueNodeId: 'I_example', issueNumber: 7 },
  reason: 'github_changed',
}
function current() {
  return {
    title: 'A request',
    board_id: boardUuid,
    board_slug: 'features',
    status_id: oldStatus,
    status_name: 'Open',
    status_slug: 'open',
    status_color: '#aaa',
    moderation_state: 'published',
    deleted_at: null,
    board_deleted_at: null,
  }
}
function fixture() {
  const txExecute = vi
    .fn()
    .mockResolvedValueOnce([current()])
    .mockResolvedValueOnce([{ id: newStatus, name: 'Declined', slug: 'declined', color: '#bbb' }])
    .mockResolvedValueOnce([{ id: postUuid }])
    .mockResolvedValueOnce([])
  const values = vi.fn().mockResolvedValue(undefined)
  const insert = vi.fn((_table: unknown) => ({ values }))
  const tx = { execute: txExecute, insert } as unknown as Parameters<typeof applyPipelineStatus>[0]
  return { tx, txExecute, insert, values }
}
const event = {
  id: eventId,
  timestamp: '2026-10-02T00:00:00Z',
  type: 'post.status_changed',
  actor: { type: 'service' },
  data: {
    post: {
      id: input.postId,
      title: 'A request',
      boardId: fromUuid('board', boardUuid),
      boardSlug: 'features',
    },
    previousStatus: 'Open',
    newStatus: 'Declined',
  },
}
beforeEach(() => {
  execute.mockReset()
  transaction.mockReset()
  processEvent.mockReset()
})

describe('atomic native status effects', () => {
  it('writes native audit, activity and the stable event using the supplied transaction', async () => {
    const f = fixture()
    const result = await applyPipelineStatus(f.tx, input)
    expect(result.changed).toBe(true)
    expect(f.insert.mock.calls.map((call) => call[0])).toEqual(['native-audit', 'native-activity'])
    expect(f.values.mock.calls[0][0]).toMatchObject({
      eventType: 'post.status.changed',
      actorType: 'service',
      targetId: input.postId,
      beforeValue: { status: 'Open' },
      afterValue: { status: 'Declined', slug: 'declined' },
      metadata: { eventId: result.eventId, issueNodeId: 'I_example' },
    })
    expect(f.values.mock.calls[1][0]).toMatchObject({
      principalId: null,
      type: 'status.changed',
      metadata: {
        fromName: 'Open',
        toName: 'Declined',
        toSlug: 'declined',
        eventId: result.eventId,
      },
    })
    const outbox = query(f.txExecute.mock.calls[3][0])
    expect(outbox.sql).toContain('INSERT INTO feature_pipeline_status_outbox')
    const stored = JSON.parse(String(outbox.params[2]))
    expect(stored).toMatchObject({
      id: result.eventId,
      type: 'post.status_changed',
      actor: { type: 'service' },
      data: { previousStatus: 'Open', newStatus: 'Declined' },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(processEvent).not.toHaveBeenCalled()
  })
  it('rejects a concurrent portal change before any write or dispatch', async () => {
    const f = fixture()
    f.txExecute.mockReset().mockResolvedValue([{ ...current(), status_slug: 'withdrawn' }])
    await expect(applyPipelineStatus(f.tx, input)).rejects.toThrow('changed during reconciliation')
    expect(f.txExecute).toHaveBeenCalledTimes(1)
    expect(f.insert).not.toHaveBeenCalled()
  })
  it('rejects a post newly held for moderation', async () => {
    const f = fixture()
    f.txExecute.mockReset().mockResolvedValue([{ ...current(), moderation_state: 'pending' }])
    await expect(applyPipelineStatus(f.tx, input)).rejects.toThrow('no longer eligible')
    expect(f.insert).not.toHaveBeenCalled()
  })
  it('does not generate duplicate native effects when status already matches', async () => {
    const f = fixture()
    f.txExecute.mockReset().mockResolvedValue([{ ...current(), status_slug: 'declined' }])
    expect(await applyPipelineStatus(f.tx, { ...input, expectedStatusSlug: 'declined' })).toEqual({
      changed: false,
      eventId: null,
    })
    expect(f.insert).not.toHaveBeenCalled()
  })
  it('propagates native audit failure so the caller rolls back status and acknowledgment', async () => {
    const f = fixture()
    f.values.mockRejectedValueOnce(new Error('audit insert unavailable'))
    await expect(applyPipelineStatus(f.tx, input)).rejects.toThrow('audit insert unavailable')
    expect(f.insert).toHaveBeenCalledTimes(1)
    expect(f.txExecute).toHaveBeenCalledTimes(3)
    expect(processEvent).not.toHaveBeenCalled()
  })
  it('propagates outbox insertion failure rather than committing an unauditable notification gap', async () => {
    const f = fixture()
    f.txExecute
      .mockReset()
      .mockResolvedValueOnce([current()])
      .mockResolvedValueOnce([{ id: newStatus, name: 'Declined', slug: 'declined', color: null }])
      .mockResolvedValueOnce([{ id: postUuid }])
      .mockRejectedValueOnce(new Error('outbox unavailable'))
    await expect(applyPipelineStatus(f.tx, input)).rejects.toThrow('outbox unavailable')
  })
})

describe('durable native status dispatch', () => {
  function claim() {
    const txExecute = vi
      .fn()
      .mockResolvedValueOnce([{ event_id: eventId, payload: event }])
      .mockResolvedValueOnce([])
    execute.mockResolvedValue([{ event_id: eventId }])
    transaction.mockImplementation((fn) => fn({ execute: txExecute }))
    return txExecute
  }
  it('keeps failed target resolution or queue admission pending', async () => {
    const txExecute = claim()
    processEvent.mockRejectedValue(new Error('Redis unavailable'))
    expect(await dispatchPendingPipelineStatusEvents()).toEqual({ delivered: 0, failed: 1 })
    expect(processEvent).toHaveBeenCalledWith(event, { durable: true })
    const update = query(txExecute.mock.calls[1][0])
    expect(update.sql).toContain('last_error=')
    expect(update.sql).not.toContain('delivered_at=now()')
  })
  it('replays the identical event after enqueue succeeds but DB acknowledgment fails', async () => {
    const txExecute = claim()
    processEvent.mockResolvedValue(undefined)
    txExecute
      .mockReset()
      .mockResolvedValueOnce([{ event_id: eventId, payload: event }])
      .mockRejectedValueOnce(new Error('DB connection lost before commit'))
    await expect(dispatchPendingPipelineStatusEvents()).rejects.toThrow('DB connection lost')
    claim()
    expect(await dispatchPendingPipelineStatusEvents()).toEqual({ delivered: 1, failed: 0 })
    expect(processEvent).toHaveBeenCalledTimes(2)
    expect(processEvent.mock.calls[0][0]).toEqual(processEvent.mock.calls[1][0])
  })
  it('does not dispatch rows already claimed or acknowledged by another worker', async () => {
    const txExecute = claim()
    txExecute.mockReset().mockResolvedValueOnce([])
    expect(await dispatchPendingPipelineStatusEvents()).toEqual({ delivered: 0, failed: 0 })
    expect(processEvent).not.toHaveBeenCalled()
  })
  it('rejects a stored event whose identity differs from the durable row', async () => {
    const txExecute = claim()
    txExecute
      .mockReset()
      .mockResolvedValueOnce([{ event_id: eventId, payload: { ...event, id: 'wrong' } }])
    await expect(dispatchPendingPipelineStatusEvents()).rejects.toThrow('event identity')
    expect(processEvent).not.toHaveBeenCalled()
  })
})
