import { describe, expect, it } from 'vitest'
import { isMatchableText, searchLimit } from '../search-query'

describe('isMatchableText', () => {
  it('accepts ordinary text', () => {
    expect(isMatchableText('dark mode')).toBe(true)
    expect(isMatchableText('feature-requests')).toBe(true)
    expect(isMatchableText('')).toBe(true)
  })

  it('refuses text holding a NUL, which Postgres text cannot store', () => {
    expect(isMatchableText('\u0000')).toBe(false)
    expect(isMatchableText('a\u0000b')).toBe(false)
    expect(isMatchableText('dark mode\u0000')).toBe(false)
  })
})

describe('searchLimit', () => {
  it('keeps a whole number from 1 up to the maximum', () => {
    expect(searchLimit('1', 5, 20)).toBe(1)
    expect(searchLimit('7', 5, 20)).toBe(7)
    expect(searchLimit('20', 5, 20)).toBe(20)
  })

  it('caps a larger whole number at the maximum', () => {
    expect(searchLimit('50', 5, 20)).toBe(20)
    expect(searchLimit('1e21', 5, 20)).toBe(20)
  })

  it.each([null, '', ' ', '0', '-1', '-5', '1.5', '0.5', 'abc', 'NaN', 'Infinity', '1e400'])(
    'reads %j as absent and gives the fallback',
    (raw) => {
      expect(searchLimit(raw, 5, 20)).toBe(5)
      expect(searchLimit(raw, 10, 20)).toBe(10)
    }
  )
})
