import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defaultParseSearch } from '@tanstack/react-router'
import { generateId } from '@quackback/ids'
import {
  MAX_SEARCH_COUNT,
  isSearchCount,
  searchChoice,
  searchCount,
  searchDate,
  searchId,
  searchIdCsv,
  searchIdList,
  searchList,
  searchText,
  searchWhere,
} from '../search-params'

/**
 * The router hands validateSearch whatever its JSON-first parser made of the
 * query string. These tests feed the helpers through that same parser, so a
 * case here is exactly what a typed or pasted URL delivers in production.
 */
function fromUrl<T extends z.ZodType>(schema: T, query: string): z.output<T> {
  return schema.parse(defaultParseSearch(query))
}

describe('searchText', () => {
  const schema = z.object({ q: searchText() })

  it('keeps ordinary text', () => {
    expect(fromUrl(schema, '?q=hello')).toEqual({ q: 'hello' })
  })

  it('reads a numeric or boolean value back as its text', () => {
    expect(fromUrl(schema, '?q=123')).toEqual({ q: '123' })
    expect(fromUrl(schema, '?q=true')).toEqual({ q: 'true' })
  })

  it('keeps the app-serialized quoted form', () => {
    expect(fromUrl(schema, '?q=%22123%22')).toEqual({ q: '123' })
  })

  it('reads any other shape as absent instead of throwing', () => {
    expect(fromUrl(schema, '?q=%5B%22a%22%5D').q).toBeUndefined()
    expect(fromUrl(schema, '?q=%7B%22a%22%3A1%7D').q).toBeUndefined()
    expect(fromUrl(schema, '?q=null').q).toBeUndefined()
  })

  it('leaves an absent key absent', () => {
    expect(fromUrl(schema, '').q).toBeUndefined()
  })
})

describe('searchList', () => {
  const schema = z.object({ board: searchList() })

  it('reads a single bare value as a one-item list (DEF-45)', () => {
    expect(fromUrl(schema, '?board=feature-requests')).toEqual({ board: ['feature-requests'] })
  })

  it('keeps the app-serialized JSON list', () => {
    expect(fromUrl(schema, '?board=%5B%22a%22%2C%22b%22%5D')).toEqual({ board: ['a', 'b'] })
  })

  it('reads a repeated key as a list', () => {
    expect(fromUrl(schema, '?board=a&board=b')).toEqual({ board: ['a', 'b'] })
  })

  it('reads numeric items as text', () => {
    expect(fromUrl(schema, '?board=7')).toEqual({ board: ['7'] })
    expect(fromUrl(schema, '?board=%5B1%2C%22b%22%5D')).toEqual({ board: ['1', 'b'] })
  })

  it('reads an empty bare value as absent', () => {
    expect(fromUrl(schema, '?board=').board).toBeUndefined()
  })

  it('reads any other shape as absent instead of throwing', () => {
    expect(fromUrl(schema, '?board=%7B%22a%22%3A1%7D').board).toBeUndefined()
    expect(fromUrl(schema, '?board=%5B%5B%22a%22%5D%5D').board).toBeUndefined()
    expect(fromUrl(schema, '?board=null').board).toBeUndefined()
  })
})

describe('searchChoice', () => {
  const schema = z.object({ verified: searchChoice(['true', 'false']) })

  it('keeps a listed value', () => {
    expect(fromUrl(schema, '?verified=%22false%22')).toEqual({ verified: 'false' })
  })

  it('matches a value the parser turned into a boolean', () => {
    expect(fromUrl(schema, '?verified=true')).toEqual({ verified: 'true' })
  })

  it('reads an unlisted value as absent instead of throwing', () => {
    expect(fromUrl(schema, '?verified=maybe').verified).toBeUndefined()
    expect(fromUrl(schema, '?verified=1').verified).toBeUndefined()
    expect(fromUrl(schema, '?verified=%5B%22true%22%5D').verified).toBeUndefined()
  })
})

describe('searchWhere', () => {
  const schema = z.object({ code: searchWhere((value) => /^[a-z]+$/.test(value)) })

  it('keeps a value the predicate accepts', () => {
    expect(fromUrl(schema, '?code=abc')).toEqual({ code: 'abc' })
  })

  it('reads a value the predicate rejects as absent instead of throwing', () => {
    expect(fromUrl(schema, '?code=ABC').code).toBeUndefined()
    expect(fromUrl(schema, '?code=123').code).toBeUndefined()
    expect(fromUrl(schema, '?code=%5B%22abc%22%5D').code).toBeUndefined()
  })
})

describe('searchId', () => {
  const board = generateId('board')
  const schema = z.object({ board: searchId('board') })

  it('keeps a TypeID with the expected prefix', () => {
    expect(fromUrl(schema, `?board=${board}`)).toEqual({ board })
  })

  it('reads a slug, a number or another entity id as absent', () => {
    expect(fromUrl(schema, '?board=feature-requests').board).toBeUndefined()
    expect(fromUrl(schema, '?board=123').board).toBeUndefined()
    expect(fromUrl(schema, `?board=${generateId('tag')}`).board).toBeUndefined()
    expect(fromUrl(schema, '?board=board_notbase32').board).toBeUndefined()
  })

  it('reads a raw UUID as absent: the app never writes one to a URL', () => {
    expect(fromUrl(schema, '?board=01893d8c-7e80-7000-8000-000000000000').board).toBeUndefined()
  })
})

describe('searchIdList', () => {
  const [a, b] = [generateId('tag'), generateId('tag')]
  const schema = z.object({ tags: searchIdList('tag') })

  it('reads a single bare id as a one-item list', () => {
    expect(fromUrl(schema, `?tags=${a}`)).toEqual({ tags: [a] })
  })

  it('keeps the app-serialized JSON list and a repeated key', () => {
    const json = `?${new URLSearchParams({ tags: JSON.stringify([a, b]) })}`
    expect(fromUrl(schema, json)).toEqual({ tags: [a, b] })
    expect(fromUrl(schema, `?tags=${a}&tags=${b}`)).toEqual({ tags: [a, b] })
  })

  it('drops the items that are not ids of this entity and keeps the rest', () => {
    const json = `?${new URLSearchParams({ tags: JSON.stringify(['ux', a, generateId('board')]) })}`
    expect(fromUrl(schema, json)).toEqual({ tags: [a] })
  })

  it('reads a list with no usable id as absent', () => {
    expect(fromUrl(schema, '?tags=foo').tags).toBeUndefined()
    expect(fromUrl(schema, '?tags=').tags).toBeUndefined()
    expect(fromUrl(schema, '?tags=%5B1%2C2%5D').tags).toBeUndefined()
    expect(fromUrl(schema, '?tags=%7B%22a%22%3A1%7D').tags).toBeUndefined()
  })
})

describe('searchIdCsv', () => {
  const [a, b] = [generateId('segment'), generateId('segment')]
  const schema = z.object({ segments: searchIdCsv('segment') })

  it('keeps a comma-separated list of ids in its text form', () => {
    expect(fromUrl(schema, `?segments=${a},${b}`)).toEqual({ segments: `${a},${b}` })
  })

  it('drops the items that are not ids of this entity', () => {
    expect(fromUrl(schema, `?segments=vip,${a},,${generateId('tag')}`)).toEqual({ segments: a })
  })

  it('reads a value with no usable id as absent', () => {
    expect(fromUrl(schema, '?segments=a,b').segments).toBeUndefined()
    expect(fromUrl(schema, '?segments=7').segments).toBeUndefined()
  })
})

describe('searchCount', () => {
  const schema = z.object({ minVotes: searchCount() })

  it('keeps a whole number as its text', () => {
    expect(fromUrl(schema, '?minVotes=5')).toEqual({ minVotes: '5' })
    expect(fromUrl(schema, '?minVotes=%225%22')).toEqual({ minVotes: '5' })
    expect(fromUrl(schema, `?minVotes=${MAX_SEARCH_COUNT}`)).toEqual({
      minVotes: String(MAX_SEARCH_COUNT),
    })
  })

  it('reads text, fractions, negatives and out-of-range counts as absent', () => {
    for (const bad of ['abc', '1.5', '-1', String(MAX_SEARCH_COUNT + 1), '99999999999', '']) {
      expect(fromUrl(schema, `?minVotes=${bad}`).minVotes).toBeUndefined()
    }
  })

  it('agrees with isSearchCount', () => {
    expect(isSearchCount('0')).toBe(true)
    expect(isSearchCount('2147483647')).toBe(true)
    expect(isSearchCount('2147483648')).toBe(false)
    expect(isSearchCount('1e3')).toBe(false)
  })
})

describe('searchDate', () => {
  const schema = z.object({ dateFrom: searchDate() })

  it('keeps an ISO date or timestamp as its text', () => {
    expect(fromUrl(schema, '?dateFrom=2026-01-31')).toEqual({ dateFrom: '2026-01-31' })
    expect(fromUrl(schema, '?dateFrom=2026-09-24T10:00:00.000Z')).toEqual({
      dateFrom: '2026-09-24T10:00:00.000Z',
    })
    expect(fromUrl(schema, '?dateFrom=2026-09-24T10:00%2B02:00')).toEqual({
      dateFrom: '2026-09-24T10:00+02:00',
    })
  })

  it('reads anything else as absent instead of throwing', () => {
    for (const bad of ['yesterday', '2026-13-45', '2026', '1700000000000', '26-01-31', '']) {
      expect(fromUrl(schema, `?dateFrom=${bad}`).dateFrom).toBeUndefined()
    }
  })
})
