import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  BUILTIN_FIELDS,
  BUILTIN_FIELD_MAP,
  DEFAULT_OPERATORS,
  getFieldOperators,
  type BuiltinField,
  type FieldOperator,
} from '../segment-builtin-fields'
import type { SegmentRuleAttribute } from '@/lib/server/db'

const ALLOWED_TYPES: ReadonlyArray<BuiltinField['type']> = ['string', 'number', 'boolean', 'date']
const ALLOWED_GROUPS: ReadonlyArray<BuiltinField['group']> = ['attribute', 'account', 'activity']

describe('BUILTIN_FIELDS registry well-formedness', () => {
  it('is a non-empty array', () => {
    expect(BUILTIN_FIELDS.length).toBeGreaterThan(0)
  })

  it('every entry has a non-empty key', () => {
    for (const field of BUILTIN_FIELDS) {
      expect(field.key.length).toBeGreaterThan(0)
    }
  })

  it('every entry has a non-empty label', () => {
    for (const field of BUILTIN_FIELDS) {
      expect(field.label.trim().length, `field "${field.key}" has empty label`).toBeGreaterThan(0)
    }
  })

  it('every entry has a valid type', () => {
    for (const field of BUILTIN_FIELDS) {
      expect(ALLOWED_TYPES, `field "${field.key}" has invalid type "${field.type}"`).toContain(
        field.type
      )
    }
  })

  it('every entry has a valid group', () => {
    for (const field of BUILTIN_FIELDS) {
      expect(ALLOWED_GROUPS, `field "${field.key}" has invalid group "${field.group}"`).toContain(
        field.group
      )
    }
  })

  it('keys are unique', () => {
    const keys = BUILTIN_FIELDS.map((f) => f.key)
    const uniqueKeys = new Set(keys)
    expect(uniqueKeys.size).toBe(keys.length)
  })

  it('includes all expected built-in keys', () => {
    const keys: Set<string> = new Set(BUILTIN_FIELDS.map((f) => f.key))
    const expected = [
      'email',
      'email_verified',
      'created_at_days_ago',
      'post_count',
      'vote_count',
      'comment_count',
      'name',
      'locale',
      'country',
      'last_active_days_ago',
      'signup_source',
      'principal_type',
    ]
    for (const key of expected) {
      expect(keys.has(key), `expected key "${key}" to be in BUILTIN_FIELDS`).toBe(true)
    }
  })

  it('does NOT include display_name (dropped — redundant with name for portal users)', () => {
    const keys: Set<string> = new Set(BUILTIN_FIELDS.map((f) => f.key))
    expect(keys.has('display_name')).toBe(false)
  })

  it('does NOT include plan or metadata_key (those are the custom-attribute mechanism)', () => {
    const keys: Set<string> = new Set(BUILTIN_FIELDS.map((f) => f.key))
    expect(keys.has('plan')).toBe(false)
    expect(keys.has('metadata_key')).toBe(false)
  })

  it('principal_type has allowedValues of ["user", "anonymous"]', () => {
    const field = BUILTIN_FIELDS.find((f) => f.key === 'principal_type')
    expect(field).toBeDefined()
    expect(field!.allowedValues).toEqual(['user', 'anonymous'])
  })

  it('email_verified has type boolean', () => {
    const field = BUILTIN_FIELDS.find((f) => f.key === 'email_verified')
    expect(field?.type).toBe('boolean')
  })

  it('numeric fields have type number', () => {
    for (const key of [
      'created_at_days_ago',
      'last_active_days_ago',
      'post_count',
      'vote_count',
      'comment_count',
    ]) {
      const field = BUILTIN_FIELDS.find((f) => f.key === key)
      expect(field?.type, `"${key}" should be number`).toBe('number')
    }
  })

  it('string fields have type string', () => {
    for (const key of ['email', 'name', 'locale', 'country', 'signup_source', 'principal_type']) {
      const field = BUILTIN_FIELDS.find((f) => f.key === key)
      expect(field?.type, `"${key}" should be string`).toBe('string')
    }
  })

  it('attribute-group fields are name, email, email_verified, locale (genuine user attributes)', () => {
    const attributeKeys = BUILTIN_FIELDS.filter((f) => f.group === 'attribute').map((f) => f.key)
    expect(attributeKeys).toEqual(
      expect.arrayContaining(['name', 'email', 'email_verified', 'locale'])
    )
    expect(attributeKeys).not.toContain('principal_type')
    expect(attributeKeys).not.toContain('post_count')
    expect(attributeKeys).not.toContain('vote_count')
    expect(attributeKeys).not.toContain('comment_count')
    expect(attributeKeys).not.toContain('created_at_days_ago')
  })

  it('account-group fields include principal_type, created_at_days_ago, country, last_active_days_ago, signup_source', () => {
    const accountKeys = BUILTIN_FIELDS.filter((f) => f.group === 'account').map((f) => f.key)
    expect(accountKeys).toEqual(
      expect.arrayContaining([
        'principal_type',
        'created_at_days_ago',
        'country',
        'last_active_days_ago',
        'signup_source',
      ])
    )
    expect(accountKeys).not.toContain('name')
    expect(accountKeys).not.toContain('email')
    expect(accountKeys).not.toContain('email_verified')
    expect(accountKeys).not.toContain('post_count')
    expect(accountKeys).not.toContain('vote_count')
    expect(accountKeys).not.toContain('comment_count')
  })

  it('activity-group fields are post_count, vote_count, comment_count', () => {
    const activityKeys = BUILTIN_FIELDS.filter((f) => f.group === 'activity').map((f) => f.key)
    expect(activityKeys).toEqual(
      expect.arrayContaining(['post_count', 'vote_count', 'comment_count'])
    )
    expect(activityKeys).not.toContain('name')
    expect(activityKeys).not.toContain('email')
    expect(activityKeys).not.toContain('email_verified')
    expect(activityKeys).not.toContain('principal_type')
    expect(activityKeys).not.toContain('created_at_days_ago')
  })
})

describe('BUILTIN_FIELD_MAP', () => {
  it('is a Map', () => {
    expect(BUILTIN_FIELD_MAP instanceof Map).toBe(true)
  })

  it('has the same size as BUILTIN_FIELDS', () => {
    expect(BUILTIN_FIELD_MAP.size).toBe(BUILTIN_FIELDS.length)
  })

  it('each BUILTIN_FIELDS entry is accessible by key', () => {
    for (const field of BUILTIN_FIELDS) {
      expect(BUILTIN_FIELD_MAP.get(field.key)).toBe(field)
    }
  })
})

describe('every registry key is a valid SegmentRuleAttribute', () => {
  // The SegmentRuleAttribute union written out as data. `satisfies` makes the
  // type checker reject a member missing from this object and a key the union
  // does not have, so the object and the union cannot drift apart.
  const SEGMENT_RULE_ATTRIBUTES = {
    email: true,
    email_verified: true,
    created_at_days_ago: true,
    post_count: true,
    vote_count: true,
    comment_count: true,
    plan: true,
    metadata_key: true,
    name: true,
    locale: true,
    country: true,
    last_active_days_ago: true,
    signup_source: true,
    principal_type: true,
  } as const satisfies Record<SegmentRuleAttribute, true>

  it('every registry key is a SegmentRuleAttribute', () => {
    // Compile time, checked by `tsc` (the web typecheck covers this file): a
    // registry key outside the union is a type error here. Do not cast the key
    // with `as SegmentRuleAttribute` instead; that compiles for any key while
    // one other key overlaps the union.
    expectTypeOf<(typeof BUILTIN_FIELDS)[number]['key']>().toExtend<SegmentRuleAttribute>()

    // Run time, so the vitest run reports the same mismatch.
    const attributes = Object.keys(SEGMENT_RULE_ATTRIBUTES)
    for (const field of BUILTIN_FIELDS) {
      expect(attributes, `registry key "${field.key}" is not a SegmentRuleAttribute`).toContain(
        field.key
      )
    }
  })
})

describe('DEFAULT_OPERATORS', () => {
  it('covers all four base types', () => {
    for (const t of ['string', 'number', 'boolean', 'date'] as const) {
      expect(DEFAULT_OPERATORS[t].length).toBeGreaterThan(0)
    }
  })

  it('string default includes contains, starts_with, ends_with', () => {
    const ops = DEFAULT_OPERATORS.string.map((o) => o.value)
    expect(ops).toContain('contains')
    expect(ops).toContain('starts_with')
    expect(ops).toContain('ends_with')
  })

  it('boolean default does NOT include numeric operators', () => {
    const ops = DEFAULT_OPERATORS.boolean.map((o) => o.value)
    for (const numOp of ['gt', 'gte', 'lt', 'lte']) {
      expect(ops).not.toContain(numOp)
    }
  })
})

describe('getFieldOperators', () => {
  it('email uses the string type default (full operator set including contains, starts_with)', () => {
    const field = BUILTIN_FIELDS.find((f) => f.key === 'email') as BuiltinField | undefined
    expect(field).toBeDefined()
    // email has no operators override — falls back to string default
    expect((field as BuiltinField & { operators?: unknown }).operators).toBeUndefined()
    const ops = getFieldOperators(field!).map(
      (o: { value: FieldOperator; label: string }) => o.value
    )
    expect(ops).toContain('eq')
    expect(ops).toContain('neq')
    expect(ops).toContain('contains')
    expect(ops).toContain('starts_with')
    expect(ops).toContain('ends_with')
    expect(ops).toContain('is_set')
    expect(ops).toContain('is_not_set')
  })

  it('returns field.operators for principal_type (only eq/neq)', () => {
    const field = BUILTIN_FIELDS.find((f) => f.key === 'principal_type')!
    const ops = getFieldOperators(field).map((o) => o.value)
    expect(ops).toEqual(['eq', 'neq'])
  })

  it('returns field.operators for created_at_days_ago (no is_set/is_not_set)', () => {
    const field = BUILTIN_FIELDS.find((f) => f.key === 'created_at_days_ago')!
    const ops = getFieldOperators(field).map((o) => o.value)
    expect(ops).not.toContain('is_set')
    expect(ops).not.toContain('is_not_set')
    expect(ops).toContain('gt')
    expect(ops).toContain('lte')
  })

  it('returns type default for name (no operators override)', () => {
    const field = BUILTIN_FIELDS.find((f) => f.key === 'name') as BuiltinField | undefined
    expect(field).toBeDefined()
    expect(field!.operators).toBeUndefined()
    const ops = getFieldOperators(field!).map((o) => o.value)
    // Should use string default — has contains
    expect(ops).toContain('contains')
  })

  it('locale uses the string type default (is_set/is_not_set are meaningful — locale is nullable)', () => {
    const field = BUILTIN_FIELDS.find((f) => f.key === 'locale') as BuiltinField | undefined
    expect(field).toBeDefined()
    expect(field!.operators).toBeUndefined()
    const ops = getFieldOperators(field!).map((o) => o.value)
    expect(ops).toContain('eq')
    expect(ops).toContain('contains')
    expect(ops).toContain('starts_with')
    expect(ops).toContain('is_set')
    expect(ops).toContain('is_not_set')
  })

  it('post_count operators include is_set/is_not_set', () => {
    const field = BUILTIN_FIELDS.find((f) => f.key === 'post_count')!
    const ops = getFieldOperators(field).map((o) => o.value)
    expect(ops).toContain('is_set')
    expect(ops).toContain('is_not_set')
  })
})
