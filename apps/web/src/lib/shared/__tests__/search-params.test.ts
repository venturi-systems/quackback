import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defaultParseSearch } from '@tanstack/react-router'
import { searchChoice, searchList, searchText } from '../search-params'

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
