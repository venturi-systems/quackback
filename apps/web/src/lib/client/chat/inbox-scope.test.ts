import { describe, it, expect } from 'vitest'
import { generateId } from '@quackback/ids'
import type { ChatTagId, SegmentId } from '@quackback/ids'
import {
  navFromSearch,
  buildListParams,
  inboxConversationParam,
  inboxSearchParam,
  MAX_INBOX_SEARCH_LENGTH,
  type InboxNavItem,
} from './inbox-scope'

const tagId = 'chat_tag_x' as ChatTagId
const segId = 'segment_y' as SegmentId

describe('navFromSearch', () => {
  it('resolves a tag scope', () => {
    expect(navFromSearch({ tag: tagId })).toEqual({ kind: 'tag', tagId })
  })

  it('resolves a segment scope when there is no tag', () => {
    expect(navFromSearch({ segment: segId })).toEqual({ kind: 'segment', segmentId: segId })
  })

  it('prefers tag over segment over view (exclusive precedence)', () => {
    expect(navFromSearch({ tag: tagId, segment: segId, view: 'mine' })).toEqual({
      kind: 'tag',
      tagId,
    })
    expect(navFromSearch({ segment: segId, view: 'mine' })).toEqual({
      kind: 'segment',
      segmentId: segId,
    })
  })

  it('falls back to the view, defaulting to "all"', () => {
    expect(navFromSearch({ view: 'unassigned' })).toEqual({ kind: 'view', view: 'unassigned' })
    expect(navFromSearch({})).toEqual({ kind: 'view', view: 'all' })
  })
})

describe('buildListParams', () => {
  const view = (v: 'mine' | 'unassigned' | 'all' | 'mentions'): InboxNavItem => ({
    kind: 'view',
    view: v,
  })

  it('maps a tag scope to tagIds, carrying status/priority/search', () => {
    expect(buildListParams({ kind: 'tag', tagId }, 'open', 'high', 'refund')).toEqual({
      tagIds: [tagId],
      status: 'open',
      priority: 'high',
      search: 'refund',
    })
  })

  it('maps a segment scope to segmentIds', () => {
    expect(buildListParams({ kind: 'segment', segmentId: segId }, 'closed', 'all', '')).toEqual({
      segmentIds: [segId],
      status: 'closed',
      priority: undefined,
      search: undefined,
    })
  })

  it('maps the mentions view to a self-contained feed (no status/priority/assignee)', () => {
    expect(buildListParams(view('mentions'), 'open', 'high', 'hi')).toEqual({
      view: 'mentions',
      search: 'hi',
    })
  })

  it('maps assignee queues, dropping "all" status/priority to undefined', () => {
    expect(buildListParams(view('mine'), 'all', 'all', '')).toEqual({
      status: undefined,
      priority: undefined,
      assignee: 'mine',
      search: undefined,
    })
    expect(buildListParams(view('unassigned'), 'open', 'all', '')).toEqual({
      status: 'open',
      priority: undefined,
      assignee: 'unassigned',
      search: undefined,
    })
    expect(buildListParams(view('all'), 'open', 'all', '')).toEqual({
      status: 'open',
      priority: undefined,
      assignee: 'all',
      search: undefined,
    })
  })

  it('holds typed search text to the length the list accepts', () => {
    const long = 'a'.repeat(MAX_INBOX_SEARCH_LENGTH + 50)
    expect(buildListParams(view('all'), 'all', 'all', long).search).toBe(
      'a'.repeat(MAX_INBOX_SEARCH_LENGTH)
    )
  })
})

// DEF-45: a hand-typed or shared inbox URL must never feed the list or thread
// query a value it answers 500 on.
describe('inboxConversationParam', () => {
  it('keeps a conversation id', () => {
    const id = generateId('conversation')
    expect(inboxConversationParam(id)).toBe(id)
  })

  it('reads anything else as absent', () => {
    for (const value of ['foo', 'conversation_foo', generateId('post'), 123, true, null, [], {}]) {
      expect(inboxConversationParam(value)).toBeUndefined()
    }
    expect(inboxConversationParam(undefined)).toBeUndefined()
  })
})

describe('inboxSearchParam', () => {
  it('keeps search text, and reads a number or boolean as its text', () => {
    expect(inboxSearchParam('refund')).toBe('refund')
    expect(inboxSearchParam('a\\')).toBe('a\\')
    expect(inboxSearchParam(123)).toBe('123')
    expect(inboxSearchParam(true)).toBe('true')
  })

  it('keeps text up to the length the list accepts and no longer', () => {
    const max = 'a'.repeat(MAX_INBOX_SEARCH_LENGTH)
    expect(inboxSearchParam(max)).toBe(max)
    expect(inboxSearchParam(`${max}a`)).toBeUndefined()
  })

  it('reads an empty value, a NUL and any other shape as absent', () => {
    for (const value of ['', 'a\u0000b', '\u0000', null, undefined, ['a'], { a: 1 }]) {
      expect(inboxSearchParam(value)).toBeUndefined()
    }
  })
})
