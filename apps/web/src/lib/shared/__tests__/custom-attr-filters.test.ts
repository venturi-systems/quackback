import { describe, expect, it } from 'vitest'
import { NUMERIC_ATTR_OPS, isFiniteAttrNumber, parseCustomAttrs } from '../custom-attr-filters'

describe('parseCustomAttrs', () => {
  it('reads key:op:value parts, keeping colons inside the value', () => {
    expect(parseCustomAttrs('plan:eq:pro,url:starts_with:https://a.example,seats:gte:5')).toEqual([
      { key: 'plan', op: 'eq', value: 'pro' },
      { key: 'url', op: 'starts_with', value: 'https://a.example' },
      { key: 'seats', op: 'gte', value: '5' },
    ])
  })

  it('reads nothing as absent and drops parts without a key or operator', () => {
    expect(parseCustomAttrs(undefined)).toBeUndefined()
    expect(parseCustomAttrs('')).toBeUndefined()
    expect(parseCustomAttrs('plan,:eq:pro,plan:eq:pro')).toEqual([
      { key: 'plan', op: 'eq', value: 'pro' },
    ])
  })

  it('drops a numeric comparison whose value is not a finite number', () => {
    for (const op of NUMERIC_ATTR_OPS) {
      for (const value of ['abc', '', ' ', 'NaN', 'Infinity', '-Infinity', '1e400', '5px']) {
        expect(parseCustomAttrs(`seats:${op}:${value}`)).toEqual([])
      }
    }
  })

  it('keeps a numeric comparison with a finite value and the other filters beside it', () => {
    expect(parseCustomAttrs('seats:gt:abc,seats:lte:-2.5,plan:eq:abc')).toEqual([
      { key: 'seats', op: 'lte', value: '-2.5' },
      { key: 'plan', op: 'eq', value: 'abc' },
    ])
  })

  it('leaves text operators alone whatever their value', () => {
    expect(parseCustomAttrs('plan:contains:,plan:is_set:')).toEqual([
      { key: 'plan', op: 'contains', value: '' },
      { key: 'plan', op: 'is_set', value: '' },
    ])
  })
})

describe('isFiniteAttrNumber', () => {
  it('accepts finite numbers and refuses empty text, NaN and infinities', () => {
    expect(isFiniteAttrNumber('5')).toBe(true)
    expect(isFiniteAttrNumber('-0.25')).toBe(true)
    expect(isFiniteAttrNumber('')).toBe(false)
    expect(isFiniteAttrNumber('NaN')).toBe(false)
    expect(isFiniteAttrNumber('1e400')).toBe(false)
  })
})
