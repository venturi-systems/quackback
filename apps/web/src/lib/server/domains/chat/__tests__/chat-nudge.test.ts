import { describe, it, expect } from 'vitest'
import { shouldSendNudge } from '../chat.nudge'
import type { ChatCard } from '@/lib/shared/db-types'

const draft = (status: 'proposed' | 'published' | 'dismissed'): ChatCard => ({
  type: 'draft_post',
  status,
  boardId: 'board_1',
  title: 'A great idea',
  content: 'body',
})

describe('shouldSendNudge', () => {
  it('nudges a still-proposed draft when a recipient address is known', () => {
    expect(shouldSendNudge(draft('proposed'), 'visitor@example.com')).toBe(true)
  })

  it('skips a draft the visitor already published', () => {
    expect(shouldSendNudge(draft('published'), 'visitor@example.com')).toBe(false)
  })

  it('skips a draft the visitor dismissed', () => {
    expect(shouldSendNudge(draft('dismissed'), 'visitor@example.com')).toBe(false)
  })

  it('skips when there is no card', () => {
    expect(shouldSendNudge(undefined, 'visitor@example.com')).toBe(false)
  })

  it('skips a proposed draft with no deliverable address', () => {
    expect(shouldSendNudge(draft('proposed'), null)).toBe(false)
  })

  it('skips a non-draft card (e.g. a shared post reference)', () => {
    const postRef: ChatCard = { type: 'post_ref', postId: 'post_1' }
    expect(shouldSendNudge(postRef, 'visitor@example.com')).toBe(false)
  })
})
