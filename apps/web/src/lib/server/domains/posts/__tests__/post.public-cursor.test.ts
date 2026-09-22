import { describe, expect, it } from 'vitest'
import { generateId } from '@quackback/ids'
import { encodePublicPostCursor, decodePublicPostCursor } from '../post.public-cursor'

const post = { id: generateId('post'), cursorCreatedAt: '2026-09-19T12:34:56.123456Z' }
const filters = { boardSlug: 'ideas', limit: 20 }
const token = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url')

describe('newest public post cursor', () => {
  it('round-trips all six timestamp fractional digits without using Date', () => {
    const cursor = encodePublicPostCursor(post, filters)
    expect(decodePublicPostCursor(cursor, filters)).toEqual({
      id: post.id,
      createdAt: post.cursorCreatedAt,
    })
    expect(decodePublicPostCursor(cursor, filters).createdAt).not.toBe(
      new Date(post.cursorCreatedAt).toISOString()
    )
  })

  it.each([
    'boardSlug',
    'search',
    'statusSlugs',
    'statusIds',
    'tagIds',
    'minVotes',
    'dateFrom',
    'responded',
    'limit',
  ])('rejects a cursor reused with changed %s', (field) => {
    const changed = {
      boardSlug: 'other',
      search: 'different',
      statusSlugs: ['planned'],
      statusIds: [generateId('status')],
      tagIds: [generateId('tag')],
      minVotes: 5,
      dateFrom: '2026-01-01',
      responded: 'responded',
      limit: 40,
    }
    expect(() =>
      decodePublicPostCursor(encodePublicPostCursor(post, filters), {
        ...filters,
        [field]: changed[field as keyof typeof changed],
      })
    ).toThrow('Invalid newest-post cursor')
  })

  it('accepts equivalent set filter ordering and duplicate values', () => {
    const original = { ...filters, statusSlugs: ['planned', 'open'], tagIds: ['tag_a', 'tag_b'] }
    expect(
      decodePublicPostCursor(encodePublicPostCursor(post, original), {
        ...original,
        statusSlugs: ['open', 'planned', 'open'],
        tagIds: ['tag_b', 'tag_a'],
      }).id
    ).toBe(post.id)
  })

  it('accepts reordered and deduplicated status IDs', () => {
    const ids = [generateId('status'), generateId('status')]
    const cursor = encodePublicPostCursor(post, { ...filters, statusIds: ids })
    expect(
      decodePublicPostCursor(cursor, { ...filters, statusIds: [ids[1], ids[0], ids[1]] }).id
    ).toBe(post.id)
  })

  it('ignores status IDs when status slugs take precedence in the query', () => {
    const original = { ...filters, statusSlugs: ['open'], statusIds: [generateId('status')] }
    expect(
      decodePublicPostCursor(encodePublicPostCursor(post, original), {
        ...original,
        statusIds: [generateId('status')],
      }).id
    ).toBe(post.id)
  })

  it('accepts undefined and empty filters for an unfiltered SSR continuation', () => {
    expect(
      decodePublicPostCursor(encodePublicPostCursor(post, {}), {
        boardSlug: '',
        search: '',
        statusIds: [],
        statusSlugs: [],
        tagIds: [],
        limit: 20,
      }).id
    ).toBe(post.id)
  })

  it.each(['', '!', 'a'.repeat(513), 'not-json', token({}), token({ version: 99 })])(
    'rejects malformed or unsupported tokens: %s',
    (cursor) => {
      expect(() => decodePublicPostCursor(cursor, filters)).toThrow('Invalid newest-post cursor')
    }
  )

  it.each([
    { version: 2 },
    { sort: 'top' },
    { id: generateId('board') },
    { createdAt: '2026-09-19T12:34:56.123Z' },
    { createdAt: '2026-02-30T12:34:56.123456Z' },
    { createdAt: '0000-09-19T12:34:56.123456Z' },
    { createdAt: '2026-09-19T12:34:56.123456+00:00' },
    { unexpected: true },
  ])('rejects invalid payload fields: %j', (changes) => {
    const payload = JSON.parse(
      Buffer.from(encodePublicPostCursor(post, filters), 'base64url').toString()
    )
    expect(() => decodePublicPostCursor(token({ ...payload, ...changes }), filters)).toThrow(
      'Invalid newest-post cursor'
    )
  })

  it('rejects malformed UTF-8 even when a later duplicate field hides the invalid value', () => {
    const payload = Buffer.from(encodePublicPostCursor(post, filters), 'base64url').toString()
    const bytes = Buffer.concat([
      Buffer.from('{"createdAt":"'),
      Buffer.from([0xff]),
      Buffer.from('",' + payload.slice(1)),
    ])
    expect(() => decodePublicPostCursor(bytes.toString('base64url'), filters)).toThrow(
      'Invalid newest-post cursor'
    )
  })
})
