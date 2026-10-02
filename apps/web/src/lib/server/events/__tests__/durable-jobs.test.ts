import { describe, expect, it } from 'vitest'
import { durableHookJobs } from '../durable-jobs'
import type { PostStatusChangedEvent } from '../types'

const event: PostStatusChangedEvent = {
  id: 'stable-event',
  timestamp: '2026-10-02T00:00:00Z',
  type: 'post.status_changed',
  actor: { type: 'service' },
  data: {
    post: { id: 'post_1', title: 'Request', boardId: 'board_1', boardSlug: 'features' },
    previousStatus: 'Open',
    newStatus: 'Deferred',
  },
}
describe('durable event queue identity', () => {
  it('keeps the same email job through rotated credentials and unsubscribe URLs', () => {
    const make = (token: string) =>
      durableHookJobs(event, [
        {
          type: 'email',
          target: { email: 'customer@example.com', unsubscribeUrl: token },
          config: { accessToken: token },
        },
      ])[0]
    expect(make('old').opts.jobId).toBe(make('new').opts.jobId)
    expect(make('old').opts).toMatchObject({ removeOnComplete: false, removeOnFail: false })
    expect(make('old').opts.jobId).not.toContain('customer@example.com')
  })
  it('deduplicates each notification recipient independently of batch order and membership', () => {
    const jobs = (ids: string[]) =>
      durableHookJobs(event, [
        {
          type: 'notification',
          target: { principalIds: ids },
          config: {},
        },
      ])
    const first = jobs(['principal_A', 'principal_B', 'principal_A'])
    const retry = jobs(['principal_B', 'principal_C', 'principal_A'])
    expect(first).toHaveLength(2)
    expect(first[0].opts.jobId).toBe(retry[2].opts.jobId)
    expect(first[1].opts.jobId).toBe(retry[0].opts.jobId)
    expect(new Set(retry.map((j) => j.opts.jobId)).size).toBe(3)
  })
  it('keeps different events and hook destinations separate', () => {
    const target = { type: 'slack', target: { channelId: 'channel_A' }, config: {} }
    const first = durableHookJobs(event, [target])[0]
    expect(durableHookJobs({ ...event, id: 'new-event' }, [target])[0].opts.jobId).not.toBe(
      first.opts.jobId
    )
    expect(
      durableHookJobs(event, [{ ...target, target: { channelId: 'channel_B' } }])[0].opts.jobId
    ).not.toBe(first.opts.jobId)
  })
  it('does not silently enqueue an unsupported destination without a stable identity', () => {
    expect(() => durableHookJobs(event, [{ type: 'unknown', target: {}, config: {} }])).toThrow(
      'stable destination'
    )
  })
})
