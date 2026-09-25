import { describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'

// DEF-45 remainder: a hand-made `/_serverFn/` call reaches these validators
// without the route or the UI, so each input takes only what its query
// accepts. An id column throws on anything but a TypeID of its entity,
// Postgres rejects a NUL in text, and LIMIT / OFFSET take only whole numbers.
// Each case lists what the app sends (accepted) and a hand-made value the
// query would fail on (refused).

type InputSchema = {
  safeParse(value: unknown): { success: boolean; data?: unknown }
}

const { inputs } = vi.hoisted(() => ({ inputs: new Map<unknown, InputSchema | undefined>() }))

vi.mock('@tanstack/react-start', () => ({
  // workspace.ts getSettings is server-only (createServerOnlyFn).
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    let input: InputSchema | undefined
    const chain = {
      validator(schema: InputSchema) {
        input = schema
        return chain
      },
      handler(fn: unknown) {
        inputs.set(fn, input)
        return fn
      },
    }
    return chain
  },
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({
  getOptionalAuth: vi.fn(),
  hasAuthCredentials: vi.fn(),
  policyActorFromAuth: vi.fn(),
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/server/functions/portal-access', () => ({
  resolvePortalAccessForRequest: vi.fn(),
}))
vi.mock('@/lib/server/domains/notifications/notification.service', () => ({}))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))

import * as admin from '../admin'
import * as changelog from '../changelog'
import * as chat from '../chat'
import * as comments from '../comments'
import * as feedback from '../feedback'
import * as notifications from '../notifications'
import * as postMerge from '../post-merge'
import * as subscriptions from '../subscriptions'

const NUL = '\u0000'
const BOARD = generateId('board')
const CHANGELOG = generateId('changelog')
const CHAT_TAG = generateId('chat_tag')
const COMMENT = generateId('comment')
const CONVERSATION = generateId('conversation')
const MESSAGE = generateId('chat_msg')
const NOTIFICATION = generateId('notification')
const POST = generateId('post')
const PRINCIPAL = generateId('principal')
const SEGMENT = generateId('segment')
const SOURCE = generateId('feedback_source')
const STATUS = generateId('status')

function inputOf(fn: unknown): InputSchema {
  const schema = inputs.get(fn)
  if (!schema) throw new Error('server function has no validator')
  return schema
}

type Case = [name: string, fn: unknown, accepted: unknown[], refused: unknown[]]

function expectInputs(fn: unknown, accepted: unknown[], refused: unknown[]) {
  const schema = inputOf(fn)
  for (const value of accepted) {
    expect(schema.safeParse(value).success, `accepts ${JSON.stringify(value)}`).toBe(true)
  }
  for (const value of refused) {
    expect(schema.safeParse(value).success, `refuses ${JSON.stringify(value)}`).toBe(false)
  }
}

describe('chat.ts inputs (DEF-45)', () => {
  it.each<Case>([
    [
      'sendChatMessageFn',
      chat.sendChatMessageFn,
      [{ content: 'Hello' }, { conversationId: CONVERSATION, content: 'Hello' }],
      [
        { conversationId: 'conv_1', content: 'Hello' },
        { conversationId: POST, content: 'Hello' },
      ],
    ],
    [
      'getMyChatFn',
      chat.getMyChatFn,
      [undefined, {}, { conversationId: null }, { conversationId: CONVERSATION }],
      [{ conversationId: 'garbage' }, { conversationId: MESSAGE }],
    ],
    [
      'listChatMessagesFn',
      chat.listChatMessagesFn,
      [{ conversationId: CONVERSATION }, { conversationId: CONVERSATION, before: MESSAGE }],
      [
        { conversationId: 'c1' },
        { conversationId: CONVERSATION, before: 'msg_1' },
        { conversationId: CONVERSATION, before: CONVERSATION },
      ],
    ],
    [
      'getConversationFn',
      chat.getConversationFn,
      [{ conversationId: CONVERSATION, before: MESSAGE }],
      [{ conversationId: `${CONVERSATION}${NUL}` }],
    ],
    [
      'listConversationsFn',
      chat.listConversationsFn,
      [
        {},
        {
          status: 'open',
          assignee: 'mine',
          search: 'refund',
          tagIds: [CHAT_TAG],
          segmentIds: [SEGMENT],
          view: 'mentions',
          before: CONVERSATION,
        },
      ],
      [
        { search: `re${NUL}fund` },
        { tagIds: ['tag_1'] },
        { tagIds: [generateId('tag')] },
        { segmentIds: ['vip'] },
        { before: '2026-01-01T00:00:00Z' },
        { before: MESSAGE },
      ],
    ],
    [
      'listConversationsForUserFn',
      chat.listConversationsForUserFn,
      [{ principalId: PRINCIPAL }, { principalId: PRINCIPAL, before: CONVERSATION }],
      [{ principalId: 'user_1' }, { principalId: PRINCIPAL, before: 'x' }],
    ],
    [
      'assignConversationFn',
      chat.assignConversationFn,
      [
        { conversationId: CONVERSATION },
        { conversationId: CONVERSATION, assignTo: 'me' },
        { conversationId: CONVERSATION, assignTo: PRINCIPAL },
        { conversationId: CONVERSATION, assignTo: null },
      ],
      [
        { conversationId: CONVERSATION, assignTo: 'someone' },
        { conversationId: CONVERSATION, assignTo: '' },
      ],
    ],
    [
      'markConversationUnreadFromMessageFn',
      chat.markConversationUnreadFromMessageFn,
      [{ conversationId: CONVERSATION, messageId: MESSAGE }],
      [{ conversationId: CONVERSATION, messageId: CONVERSATION }],
    ],
    [
      'createPostFromConversationFn',
      chat.createPostFromConversationFn,
      [{ conversationId: CONVERSATION, boardId: BOARD, asUpvoteOfPostId: POST }],
      [
        { conversationId: CONVERSATION, boardId: 'features' },
        { conversationId: CONVERSATION, boardId: BOARD, asUpvoteOfPostId: 'post_1' },
      ],
    ],
    [
      'sharePostFn',
      chat.sharePostFn,
      [{ conversationId: CONVERSATION, postId: POST }],
      [{ conversationId: CONVERSATION, postId: BOARD }],
    ],
    [
      'getLinkedConversationsForPostFn',
      chat.getLinkedConversationsForPostFn,
      [{ postId: POST }],
      [{ postId: 'post_1' }],
    ],
    [
      'deleteChatMessageFn',
      chat.deleteChatMessageFn,
      [{ messageId: MESSAGE }],
      [{ messageId: 'm1' }],
    ],
  ])('%s takes what the app sends and refuses the rest', (_name, fn, ok, refused) => {
    expectInputs(fn, ok, refused)
  })
})

describe('comments.ts inputs (DEF-45)', () => {
  it.each<Case>([
    [
      'createCommentFn',
      comments.createCommentFn,
      [
        { postId: POST, content: 'Nice' },
        { postId: POST, content: 'Nice', parentId: COMMENT, statusId: STATUS, isPrivate: true },
        { postId: POST, content: 'Nice', parentId: '', statusId: '' },
      ],
      [
        { postId: 'post_1', content: 'Nice' },
        { postId: POST, content: `Ni${NUL}ce` },
        { postId: POST, content: 'Nice', parentId: 'c1' },
        { postId: POST, content: 'Nice', parentId: POST },
        { postId: POST, content: 'Nice', statusId: 'open' },
      ],
    ],
    [
      'addReactionFn',
      comments.addReactionFn,
      [{ commentId: COMMENT, emoji: '👍' }],
      [
        { commentId: 'c1', emoji: '👍' },
        { commentId: COMMENT, emoji: NUL },
      ],
    ],
    [
      'getCommentPermissionsFn',
      comments.getCommentPermissionsFn,
      [{ commentId: COMMENT }],
      [{ commentId: 'comment_1' }, { commentId: POST }],
    ],
    [
      'userEditCommentFn',
      comments.userEditCommentFn,
      [{ commentId: COMMENT, content: 'Edited' }],
      [
        { commentId: 'c1', content: 'Edited' },
        { commentId: COMMENT, content: `Ed${NUL}ited` },
      ],
    ],
    [
      'userDeleteCommentFn',
      comments.userDeleteCommentFn,
      [{ commentId: COMMENT }],
      [{ commentId: 'c1' }],
    ],
    [
      'restoreCommentFn',
      comments.restoreCommentFn,
      [{ commentId: COMMENT }],
      [{ commentId: 'c1' }],
    ],
    ['pinCommentFn', comments.pinCommentFn, [{ commentId: COMMENT }], [{ commentId: 'c1' }]],
    ['unpinCommentFn', comments.unpinCommentFn, [{ postId: POST }], [{ postId: COMMENT }]],
    [
      'canPinCommentFn',
      comments.canPinCommentFn,
      [{ commentId: COMMENT }],
      [{ commentId: 'comment_x' }],
    ],
  ])('%s takes what the app sends and refuses the rest', (_name, fn, ok, refused) => {
    expectInputs(fn, ok, refused)
  })

  it('reads an empty parent or status id as none, as the comment service does', () => {
    const parsed = inputOf(comments.createCommentFn).safeParse({
      postId: POST,
      content: 'Nice',
      parentId: '',
      statusId: '',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({ parentId: undefined, statusId: undefined })
  })
})

describe('subscriptions.ts inputs (DEF-45)', () => {
  it.each<Case>([
    [
      'fetchSubscriptionStatus',
      subscriptions.fetchSubscriptionStatus,
      [{ postId: POST }],
      [{ postId: 'post_1' }, { postId: BOARD }],
    ],
    [
      'subscribeToPostFn',
      subscriptions.subscribeToPostFn,
      [{ postId: POST }, { postId: POST, reason: 'vote', level: 'status_only' }],
      [{ postId: 'post_1' }],
    ],
    [
      'unsubscribeFromPostFn',
      subscriptions.unsubscribeFromPostFn,
      [{ postId: POST }],
      [{ postId: `${POST}${NUL}` }],
    ],
    [
      'updateSubscriptionLevelFn',
      subscriptions.updateSubscriptionLevelFn,
      [{ postId: POST, level: 'none' }],
      [{ postId: 'post_1', level: 'none' }],
    ],
    [
      'adminUpdateVoterSubscriptionFn',
      subscriptions.adminUpdateVoterSubscriptionFn,
      [{ postId: POST, principalId: PRINCIPAL, level: 'all' }],
      [
        { postId: POST, principalId: 'user_1', level: 'all' },
        { postId: 'post_1', principalId: PRINCIPAL, level: 'all' },
      ],
    ],
  ])('%s takes what the app sends and refuses the rest', (_name, fn, ok, refused) => {
    expectInputs(fn, ok, refused)
  })
})

describe('notifications.ts inputs (DEF-45)', () => {
  it.each<Case>([
    [
      'getNotificationsFn',
      notifications.getNotificationsFn,
      [{}, { limit: 10 }, { limit: 50, offset: 0, unreadOnly: true }, { limit: 100, offset: 200 }],
      [
        { offset: 1.5 },
        { offset: -1 },
        { offset: 1e300 },
        { limit: 1.5 },
        { limit: 0 },
        { limit: 101 },
      ],
    ],
    [
      'markNotificationAsReadFn',
      notifications.markNotificationAsReadFn,
      [{ notificationId: NOTIFICATION }],
      [{ notificationId: 'n1' }, { notificationId: POST }],
    ],
    [
      'archiveNotificationFn',
      notifications.archiveNotificationFn,
      [{ notificationId: NOTIFICATION }],
      [{ notificationId: 'n1' }],
    ],
  ])('%s takes what the app sends and refuses the rest', (_name, fn, ok, refused) => {
    expectInputs(fn, ok, refused)
  })
})

describe('post-merge.ts inputs (DEF-45)', () => {
  const other = generateId('post')
  it.each<Case>([
    [
      'mergePostFn',
      postMerge.mergePostFn,
      [{ duplicatePostId: POST, canonicalPostId: other }],
      [{ duplicatePostId: 'post_1', canonicalPostId: other }],
    ],
    ['unmergePostFn', postMerge.unmergePostFn, [{ postId: POST }], [{ postId: 'post_1' }]],
    [
      'getMergedPostsFn',
      postMerge.getMergedPostsFn,
      [{ canonicalPostId: POST }],
      [{ canonicalPostId: BOARD }],
    ],
    [
      'getPostMergeInfoFn',
      postMerge.getPostMergeInfoFn,
      [{ postId: POST }],
      [{ postId: 'post_1' }, { postId: `${POST}${NUL}` }],
    ],
    [
      'fetchMergePreviewFn',
      postMerge.fetchMergePreviewFn,
      [{ canonicalPostId: POST, duplicatePostId: other }],
      [{ canonicalPostId: POST, duplicatePostId: 'x' }],
    ],
  ])('%s takes what the app sends and refuses the rest', (_name, fn, ok, refused) => {
    expectInputs(fn, ok, refused)
  })
})

describe('changelog.ts inputs (DEF-45)', () => {
  it.each<Case>([
    [
      'getPublicChangelogFn',
      changelog.getPublicChangelogFn,
      [{ id: CHANGELOG }],
      [{ id: 'changelog_x' }, { id: POST }, { id: '' }],
    ],
    [
      'listPublicChangelogsFn',
      changelog.listPublicChangelogsFn,
      [{}, { cursor: CHANGELOG, limit: 10 }],
      [{ cursor: 'x' }, { cursor: POST }],
    ],
    ['getChangelogFn', changelog.getChangelogFn, [{ id: CHANGELOG }], [{ id: 'changelog_1' }]],
    [
      'listChangelogsFn',
      changelog.listChangelogsFn,
      [{ status: 'all', cursor: CHANGELOG, limit: 20 }],
      [{ cursor: 'x' }],
    ],
    [
      'deleteChangelogFn',
      changelog.deleteChangelogFn,
      [{ id: CHANGELOG }],
      [{ id: 'changelog_1' }],
    ],
    [
      'searchShippedPostsFn',
      changelog.searchShippedPostsFn,
      [{}, { query: 'dark mode', limit: 30 }, { query: 'dark', boardId: BOARD }],
      [{ query: `dark${NUL}` }, { boardId: 'features' }, { boardId: POST }],
    ],
  ])('%s takes what the app sends and refuses the rest', (_name, fn, ok, refused) => {
    expectInputs(fn, ok, refused)
  })
})

describe('feedback.ts suggestion list input (DEF-45)', () => {
  it('takes what the app sends and refuses the rest', () => {
    expectInputs(
      feedback.fetchSuggestions,
      [
        {},
        { status: 'pending', sort: 'newest', offset: 40, limit: 20 },
        { boardId: BOARD, sourceIds: [SOURCE], sourceTypes: ['slack'] },
      ],
      [
        { limit: 1.5 },
        { limit: 0 },
        { limit: 1000 },
        { offset: -1 },
        { offset: 1.5 },
        { boardId: 'features' },
        { sourceIds: ['slack'] },
      ]
    )
  })
})

describe('admin.ts search inputs (DEF-45)', () => {
  it.each<Case>([
    [
      'searchMembersFn',
      admin.searchMembersFn,
      [{}, { search: 'ann', limit: 20 }],
      [{ search: `an${NUL}n` }, { limit: 1.5 }, { limit: -5 }, { limit: 0 }],
    ],
    [
      'fetchSegmentAttributeValuesFn',
      admin.fetchSegmentAttributeValuesFn,
      [{ attribute: 'country' }, { attribute: 'country', query: 'fr', limit: 20 }],
      [{ attribute: 'country', query: `f${NUL}r` }],
    ],
  ])('%s takes what the app sends and refuses the rest', (_name, fn, ok, refused) => {
    expectInputs(fn, ok, refused)
  })
})
