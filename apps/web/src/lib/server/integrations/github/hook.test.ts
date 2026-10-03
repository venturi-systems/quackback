import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostCreatedEvent } from '@/lib/server/events/types'
const hasIntent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/server/feature-pipeline/intent', () => ({ hasFeatureIntent: hasIntent }))
vi.mock('./message', () => ({
  buildGitHubIssueBody: () => ({ title: 'Request', body: 'Details' }),
}))
import { githubHook } from './hook'
const event = {
  id: 'event',
  type: 'post.created',
  timestamp: '2026-10-02T00:00:00Z',
  actor: { type: 'service' },
  data: {
    post: {
      id: 'post_fixture',
      title: 'Request',
      content: 'Details',
      boardId: 'board_fixture',
      boardSlug: 'ideas',
      voteCount: 0,
    },
  },
} as PostCreatedEvent
const fetcher = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetcher)
  fetcher
    .mockReset()
    .mockResolvedValue(Response.json({ number: 1, html_url: 'https://github.com/o/r/issues/1' }))
})
afterEach(() => vi.unstubAllGlobals())
describe('native creation suppression uses the captured post intent', () => {
  it('keeps suppressing a governed post even if its board is later disabled', async () => {
    hasIntent.mockResolvedValue(true)
    expect(
      await githubHook.run(
        event,
        { channelId: 'o/r' },
        { accessToken: 'test', rootUrl: 'https://feedback.example' }
      )
    ).toEqual({ success: true })
    expect(hasIntent).toHaveBeenCalledWith(event.data.post.id)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not suppress a historical ordinary post when its board is later activated', async () => {
    hasIntent.mockResolvedValue(false)
    expect(
      await githubHook.run(
        event,
        { channelId: 'o/r' },
        { accessToken: 'test', rootUrl: 'https://feedback.example' }
      )
    ).toMatchObject({ success: true, externalId: '1' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
