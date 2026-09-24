import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defaultParseSearch } from '@tanstack/react-router'
import { generateId } from '@quackback/ids'
import {
  MAX_SEARCH_COUNT,
  isSearchCount,
  isSearchDate,
  searchChoice,
  searchCount,
  searchDate,
  searchDay,
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

  it('reads a value holding a NUL as absent: Postgres rejects NUL in text', () => {
    expect(fromUrl(schema, '?q=%00').q).toBeUndefined()
    expect(fromUrl(schema, '?q=a%00b').q).toBeUndefined()
    expect(fromUrl(schema, '?q=%22a%5Cu0000b%22').q).toBeUndefined()
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

  it('reads a value or a list holding a NUL as absent', () => {
    expect(fromUrl(schema, '?board=a%00b').board).toBeUndefined()
    expect(fromUrl(schema, '?board=a&board=%00').board).toBeUndefined()
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

  it('never hands the predicate a value holding a NUL', () => {
    const accept = vi.fn((value: string) => value.length > 0)
    const anything = z.object({ code: searchWhere(accept) })
    expect(fromUrl(anything, '?code=ab%00c').code).toBeUndefined()
    expect(accept).not.toHaveBeenCalled()
    expect(fromUrl(anything, '?code=abc')).toEqual({ code: 'abc' })
    expect(accept).toHaveBeenCalledWith('abc')
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

  it('reads a date in UTC year 0 as absent: Postgres has no year 0', () => {
    expect(fromUrl(schema, '?dateFrom=0000-01-01').dateFrom).toBeUndefined()
    // Year 1 at +01:00 is 0000-12-31T23:00Z, the instant the query would send.
    expect(fromUrl(schema, '?dateFrom=0001-01-01T00:00%2B01:00').dateFrom).toBeUndefined()
    expect(fromUrl(schema, '?dateFrom=0000-12-31T23:59:59.999Z').dateFrom).toBeUndefined()
  })

  it('keeps the first and last instants of years 1 to 9999 in UTC', () => {
    expect(fromUrl(schema, '?dateFrom=0001-01-01')).toEqual({ dateFrom: '0001-01-01' })
    expect(fromUrl(schema, '?dateFrom=0001-01-01T00:00Z')).toEqual({
      dateFrom: '0001-01-01T00:00Z',
    })
    expect(fromUrl(schema, '?dateFrom=0001-01-01T00:00-01:00')).toEqual({
      dateFrom: '0001-01-01T00:00-01:00',
    })
    expect(fromUrl(schema, '?dateFrom=9999-12-31T23:59:59.999Z')).toEqual({
      dateFrom: '9999-12-31T23:59:59.999Z',
    })
  })

  it('reads an instant past 9999 in UTC as absent', () => {
    // 10000-01-01T00:59Z, which toISOString writes as +010000-01-01T00:59:00.000Z.
    expect(fromUrl(schema, '?dateFrom=9999-12-31T23:59-01:00').dateFrom).toBeUndefined()
  })

  it('keeps a timestamp without an offset only when every time zone keeps it in range', () => {
    // Local time is read in the zone of whoever parses it, and the browser and
    // the server can differ, so the answer must not depend on either zone.
    expect(fromUrl(schema, '?dateFrom=2026-09-24T10:00')).toEqual({ dateFrom: '2026-09-24T10:00' })
    expect(fromUrl(schema, '?dateFrom=0001-01-01T14:00')).toEqual({ dateFrom: '0001-01-01T14:00' })
    for (const bad of ['0000-12-31T23:30', '0001-01-01T10:00', '9999-12-31T10:00']) {
      expect(fromUrl(schema, `?dateFrom=${bad}`).dateFrom).toBeUndefined()
    }
  })

  it('agrees with isSearchDate', () => {
    expect(isSearchDate('0001-01-01')).toBe(true)
    expect(isSearchDate('0000-01-01')).toBe(false)
    expect(isSearchDate('0001-01-01T00:00+01:00')).toBe(false)
    expect(isSearchDate('9999-12-31')).toBe(true)
    expect(isSearchDate('9999-12-31T09:59:59.999')).toBe(true)
    expect(isSearchDate('2026-13-45')).toBe(false)
  })
})

describe('searchDay', () => {
  const schema = z.object({ dateFrom: searchDay() })

  it('keeps a calendar date as its text', () => {
    expect(fromUrl(schema, '?dateFrom=2026-01-31')).toEqual({ dateFrom: '2026-01-31' })
    expect(fromUrl(schema, '?dateFrom=0001-01-01')).toEqual({ dateFrom: '0001-01-01' })
  })

  it('reads a timestamp, year 0 or anything else as absent', () => {
    for (const bad of [
      '0000-01-01',
      '2026-09-24T10:00:00.000Z',
      '2026-13-45',
      'yesterday',
      '2026-01-31%00',
      '',
    ]) {
      expect(fromUrl(schema, `?dateFrom=${bad}`).dateFrom).toBeUndefined()
    }
  })
})
