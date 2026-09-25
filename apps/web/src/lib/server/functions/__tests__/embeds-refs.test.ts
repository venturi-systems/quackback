import { describe, it, expect, vi } from 'vitest'
import { generateId } from '@quackback/ids'

// DEF-45: an embed reference comes from user-written rich text, and the embed
// preview server function is reachable without signing in. A post or changelog
// is read by id, and the id columns take only a TypeID of that entity; an
// article is read by slug, and Postgres rejects a NUL in text. A reference no
// read path can take is answered unavailable, as any unresolved reference is,
// and no resolver (so no query) runs.

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = { validator: () => chain, handler: () => chain }
    return chain
  },
}))

import { isResolvableEmbedRef, resolveEmbed } from '../embeds'
import type { EmbedResolverDeps } from '../embeds'

const NUL = '\u0000'
const actor = {} as never
const BASE = 'https://feedback.example.com'

function spyDeps() {
  const deps = {
    getPostDetail: vi.fn(async () => null),
    listStatuses: vi.fn(async () => []),
    getChangelog: vi.fn(async () => null),
    getArticle: vi.fn(async () => null),
  }
  return deps as typeof deps & EmbedResolverDeps
}

describe('isResolvableEmbedRef', () => {
  it('takes a TypeID of the named entity for a post or changelog', () => {
    expect(isResolvableEmbedRef('post', generateId('post'))).toBe(true)
    expect(isResolvableEmbedRef('changelog', generateId('changelog'))).toBe(true)
  })

  it.each<[kind: 'post' | 'changelog', id: string]>([
    ['post', 'post_1'],
    ['post', ''],
    ['post', generateId('changelog')],
    ['post', `${generateId('post')}${NUL}`],
    ['changelog', 'changelog_x'],
    ['changelog', generateId('post')],
  ])('refuses %s id %j', (kind, id) => {
    expect(isResolvableEmbedRef(kind, id)).toBe(false)
  })

  it('takes any non-empty article slug without a NUL', () => {
    expect(isResolvableEmbedRef('article', 'how-to-reset-password')).toBe(true)
    expect(isResolvableEmbedRef('article', '')).toBe(false)
    expect(isResolvableEmbedRef('article', `how-to${NUL}reset`)).toBe(false)
  })
})

describe('resolveEmbed with a reference no read path can take', () => {
  it.each<[kind: 'post' | 'changelog' | 'article', id: string]>([
    ['post', 'post_1'],
    ['post', generateId('board')],
    ['changelog', 'changelog_x'],
    ['article', `slug${NUL}`],
    ['article', ''],
  ])('%s %j is unavailable and runs no resolver', async (kind, id) => {
    const deps = spyDeps()
    expect(await resolveEmbed(kind, id, actor, deps, BASE)).toEqual({ unavailable: true })
    expect(deps.getPostDetail).not.toHaveBeenCalled()
    expect(deps.listStatuses).not.toHaveBeenCalled()
    expect(deps.getChangelog).not.toHaveBeenCalled()
    expect(deps.getArticle).not.toHaveBeenCalled()
  })

  it('still reaches the resolver for a well-formed reference', async () => {
    const deps = spyDeps()
    const postId = generateId('post')
    expect(await resolveEmbed('post', postId, actor, deps, BASE)).toEqual({ unavailable: true })
    expect(deps.getPostDetail).toHaveBeenCalledWith(postId, actor)
  })
})
