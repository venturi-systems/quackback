/**
 * DEF-40: deepMerge must never let a settings payload reach a prototype.
 *
 * Every payload here goes through JSON.parse on purpose. An object literal
 * `{ __proto__: {...} }` SETS the literal's prototype, while JSON.parse makes
 * `__proto__` an ordinary own key, which is what a stored settings column or
 * a request body actually contains.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { deepMerge, parseJsonConfig } from '../settings.helpers'
import {
  DEFAULT_AUTH_CONFIG,
  DEFAULT_OFFICE_HOURS,
  DEFAULT_PORTAL_CONFIG,
  DEFAULT_WIDGET_CONFIG,
} from '../settings.types'

const PROBE = 'def40Polluted'

function objectPrototypeIsClean(): boolean {
  return !Object.prototype.hasOwnProperty.call(Object.prototype, PROBE) && !(PROBE in {})
}

/** Paths of every object, at any depth, that owns a `__proto__` key. */
function ownProtoKeyPaths(value: unknown, path = '$'): string[] {
  if (typeof value !== 'object' || value === null) return []
  const found = Object.prototype.hasOwnProperty.call(value, '__proto__') ? [path] : []
  for (const key of Object.keys(value)) {
    found.push(...ownProtoKeyPaths((value as Record<string, unknown>)[key], `${path}.${key}`))
  }
  return found
}

afterEach(() => {
  // If a guard ever regresses, keep the damage out of every later test.
  delete (Object.prototype as Record<string, unknown>)[PROBE]
})

describe('deepMerge prototype guard', () => {
  it('ignores a top-level __proto__ key', () => {
    const payload = JSON.parse(`{"__proto__":{"${PROBE}":true,"isAdmin":true}}`)
    expect(Object.prototype.hasOwnProperty.call(payload, '__proto__')).toBe(true)

    const merged = deepMerge(DEFAULT_AUTH_CONFIG, payload)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(PROBE in merged).toBe(false)
    expect('isAdmin' in merged).toBe(false)
    expect(merged).toEqual(DEFAULT_AUTH_CONFIG)
  })

  it('ignores constructor.prototype', () => {
    const payload = JSON.parse(`{"constructor":{"prototype":{"${PROBE}":true}}}`)

    const merged = deepMerge(DEFAULT_AUTH_CONFIG, payload)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(false)
    expect(merged.constructor).toBe(Object)
  })

  it('ignores a top-level prototype key', () => {
    const payload = JSON.parse(`{"prototype":{"${PROBE}":true}}`)

    const merged = deepMerge(DEFAULT_AUTH_CONFIG, payload)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(merged, 'prototype')).toBe(false)
  })

  it('ignores __proto__ and constructor nested inside a real settings key', () => {
    const payload = JSON.parse(
      `{"oauth":{"__proto__":{"${PROBE}":true},"constructor":{"prototype":{"${PROBE}":true}},"password":false}}`
    )

    const merged = deepMerge(DEFAULT_AUTH_CONFIG, payload)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(Object.getPrototypeOf(merged.oauth)).toBe(Object.prototype)
    expect(PROBE in (merged.oauth as object)).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(merged.oauth, 'constructor')).toBe(false)
    // The legitimate sibling key still merges.
    expect(merged.oauth).toEqual({ google: true, github: true, password: false })
  })

  it('does not merge keys the source only inherits', () => {
    // `openSignup` is inherited (enumerable to for...in), `oauth` is own.
    const source = Object.create({ openSignup: true })
    source.oauth = { github: false }

    const merged = deepMerge(DEFAULT_AUTH_CONFIG, source)

    expect(merged.openSignup).toBe(false)
    expect(merged.oauth).toEqual({ google: true, github: false, password: true })
  })

  it('does not mutate the target', () => {
    const target = { oauth: { google: true } }
    const payload = JSON.parse(`{"oauth":{"__proto__":{"${PROBE}":true},"github":true}}`)

    deepMerge(target, payload)

    expect(target).toEqual({ oauth: { google: true } })
    expect(Object.getPrototypeOf(target.oauth)).toBe(Object.prototype)
  })

  // None of these targets owns an object at `a`, so the source subtree is copied.
  const copyTargets: Array<[string, Record<string, unknown>]> = [
    ['an empty target', {}],
    ['a target holding null at that key', { a: null }],
    ['a target holding a string at that key', { a: 'text' }],
  ]

  it.each(copyTargets)('drops a nested __proto__ when copying into %s', (_label, target) => {
    const source = { a: { b: JSON.parse(`{"__proto__":{"${PROBE}":1}}`) } }
    expect(ownProtoKeyPaths(source)).toEqual(['$.a.b'])

    const merged = deepMerge<Record<string, unknown>>(target, source)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(ownProtoKeyPaths(merged)).toEqual([])
    expect(JSON.stringify(merged)).toBe('{"a":{"b":{}}}')
    const b = (merged.a as Record<string, unknown>).b as object
    expect(Object.getPrototypeOf(b)).toBe(Object.prototype)
    expect(PROBE in b).toBe(false)
  })

  it('copies a subtree or array the target lacks by value, and primitives as given', () => {
    const list = [{ id: 1 }]
    const source = {
      nested: { a: 1, deeper: { b: 'two', flag: false, none: null } },
      list,
      count: 3,
      label: 'x',
      empty: null,
    }

    const merged = deepMerge<Record<string, unknown>>({}, source)

    expect(merged).toEqual(source)
    // A plain subtree is rebuilt, so the merge never hands back the caller's object.
    expect(merged.nested).not.toBe(source.nested)
    // An array and its plain-object elements are copied the same way.
    expect(merged.list).not.toBe(list)
    expect((merged.list as unknown[])[0]).not.toBe(list[0])
  })
})

describe('deepMerge array element guard', () => {
  it('drops an own __proto__ key from an object inside an array', () => {
    const payload = JSON.parse(
      `{"chat":{"cannedReplies":[{"__proto__":{"${PROBE}":true},"id":"r1","title":"Hi","body":"Hello"}]}}`
    )
    expect(ownProtoKeyPaths(payload)).toEqual(['$.chat.cannedReplies.0'])

    const merged = deepMerge(DEFAULT_WIDGET_CONFIG, payload)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(ownProtoKeyPaths(merged)).toEqual([])
    const reply = merged.chat?.cannedReplies?.[0] as object
    expect(Object.getPrototypeOf(reply)).toBe(Object.prototype)
    expect(PROBE in reply).toBe(false)
    expect(reply).toEqual({ id: 'r1', title: 'Hi', body: 'Hello' })
    expect(JSON.stringify(merged.chat?.cannedReplies)).toBe(
      '[{"id":"r1","title":"Hi","body":"Hello"}]'
    )
    expect(JSON.stringify(merged)).not.toContain('__proto__')
    expect(JSON.stringify(merged)).not.toContain(PROBE)
  })

  it('drops constructor.prototype from an object inside an array', () => {
    const payload = JSON.parse(
      `{"chat":{"officeHours":{"enabled":true,"timezone":"UTC","days":[{"constructor":{"prototype":{"${PROBE}":true}},"enabled":true,"start":"09:00","end":"17:00"}]}}}`
    )

    const merged = deepMerge(DEFAULT_WIDGET_CONFIG, payload)

    expect(objectPrototypeIsClean()).toBe(true)
    const day = merged.chat?.officeHours?.days[0] as object
    expect(Object.prototype.hasOwnProperty.call(day, 'constructor')).toBe(false)
    expect(day.constructor).toBe(Object)
    expect(day).toEqual({ enabled: true, start: '09:00', end: '17:00' })
    expect(JSON.stringify(merged)).not.toContain('constructor')
    expect(JSON.stringify(merged)).not.toContain('prototype')
    expect(JSON.stringify(merged)).not.toContain(PROBE)
  })

  it('drops unsafe keys from arrays nested inside array elements and inside arrays', () => {
    const source = JSON.parse(
      `{"a":[[{"__proto__":{"${PROBE}":1},"k":1}],[1,"two",null,true]],"b":[{"inner":[{"__proto__":{"${PROBE}":1},"constructor":{"prototype":{"${PROBE}":1}},"kept":true}]}]}`
    )
    expect(ownProtoKeyPaths(source)).toEqual(['$.a.0.0', '$.b.0.inner.0'])

    const merged = deepMerge<Record<string, unknown>>({}, source)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(ownProtoKeyPaths(merged)).toEqual([])
    expect(JSON.stringify(merged)).toBe(
      '{"a":[[{"k":1}],[1,"two",null,true]],"b":[{"inner":[{"kept":true}]}]}'
    )
  })

  it('keeps primitives, null and non-plain objects inside an array as given', () => {
    class Box {
      value = 1
    }
    const when = new Date(0)
    const box = new Box()
    const list = [1, 'two', null, true, when, box]

    const merged = deepMerge<Record<string, unknown>>({}, { list })

    const copied = merged.list as unknown[]
    expect(copied).toEqual(list)
    expect(copied[4]).toBe(when)
    expect(copied[5]).toBe(box)
    expect(copied[5]).toBeInstanceOf(Box)
  })

  it('replaces the target array wholesale instead of merging elements', () => {
    const target = { days: [{ enabled: true }, { enabled: true }, { enabled: true }] }
    const source = JSON.parse('{"days":[{"enabled":false}]}')

    const merged = deepMerge(target, source)

    expect(merged.days).toEqual([{ enabled: false }])
    expect(target.days).toHaveLength(3)
  })
})

describe('parseJsonConfig prototype guard', () => {
  it('drops a stored __proto__ key and keeps the real settings', () => {
    const stored = `{"__proto__":{"${PROBE}":true},"features":{"__proto__":{"${PROBE}":true},"allowAnonymous":false}}`

    const config = parseJsonConfig(stored, DEFAULT_PORTAL_CONFIG)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(config.features)).toBe(Object.prototype)
    expect(PROBE in config).toBe(false)
    expect(PROBE in (config.features as object)).toBe(false)
    expect(config.features?.allowAnonymous).toBe(false)
    expect(config.features?.allowEditAfterEngagement).toBe(false)
  })

  it('drops a stored __proto__ nested under a key the defaults lack', () => {
    const stored = `{"extra":{"inner":{"__proto__":{"${PROBE}":true},"kept":1}}}`

    const config = parseJsonConfig<Record<string, unknown>>(stored, {})

    expect(objectPrototypeIsClean()).toBe(true)
    expect(ownProtoKeyPaths(config)).toEqual([])
    expect(JSON.stringify(config)).toBe('{"extra":{"inner":{"kept":1}}}')
    expect(config.extra).toEqual({ inner: { kept: 1 } })
  })

  it('still returns the defaults for a stored JSON null', () => {
    expect(parseJsonConfig('null', DEFAULT_AUTH_CONFIG)).toEqual(DEFAULT_AUTH_CONFIG)
  })

  it('drops a stored __proto__ at any depth inside the welcome card body arrays', () => {
    const stored = `{"welcomeCard":{"enabled":true,"title":"t","body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi","__proto__":{"${PROBE}":true},"marks":[{"type":"bold","constructor":{"prototype":{"${PROBE}":true}}}]}]}]}}}`

    const config = parseJsonConfig(stored, DEFAULT_PORTAL_CONFIG)

    expect(objectPrototypeIsClean()).toBe(true)
    expect(ownProtoKeyPaths(config)).toEqual([])
    expect(JSON.stringify(config.welcomeCard?.body)).toBe(
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi","marks":[{"type":"bold"}]}]}]}'
    )
  })
})

describe('parseJsonConfig array round-trip', () => {
  it('returns ordinary arrays of strings unchanged', () => {
    const access = {
      visibility: 'private',
      allowedDomains: ['acme.example', 'widgets.example'],
      widgetSignIn: true,
      allowedSegmentIds: ['segment_01', 'segment_02'],
    }

    const config = parseJsonConfig(JSON.stringify({ access }), DEFAULT_PORTAL_CONFIG)

    expect(config.access).toEqual(access)
    expect(JSON.stringify(config.access)).toBe(JSON.stringify(access))
  })

  it('returns ordinary arrays of objects unchanged', () => {
    const chat = {
      enabled: true,
      cannedReplies: [
        { id: 'r1', title: 'Hi', body: 'Hello there' },
        { id: 'r2', title: 'Bye', body: 'Talk soon' },
      ],
      officeHours: DEFAULT_OFFICE_HOURS,
    }

    const config = parseJsonConfig(JSON.stringify({ chat }), DEFAULT_WIDGET_CONFIG)

    expect(config.chat?.cannedReplies).toEqual(chat.cannedReplies)
    expect(config.chat?.officeHours).toEqual(DEFAULT_OFFICE_HOURS)
    expect(JSON.stringify(config.chat?.cannedReplies)).toBe(JSON.stringify(chat.cannedReplies))
    expect(JSON.stringify(config.chat?.officeHours)).toBe(JSON.stringify(DEFAULT_OFFICE_HOURS))
  })

  it('returns SSO attribute-mapping rules unchanged', () => {
    const ssoOidc = {
      enabled: false,
      discoveryUrl: 'https://idp.acme.example/.well-known/openid-configuration',
      clientId: 'client',
      autoCreateUsers: true,
      attributeMapping: {
        claimPath: 'groups',
        rules: [
          { whenContains: 'admins', role: 'admin' },
          { whenContains: 'staff', role: 'member' },
        ],
        defaultRole: 'user',
      },
    }

    const config = parseJsonConfig(JSON.stringify({ ssoOidc }), DEFAULT_AUTH_CONFIG)

    expect(config.ssoOidc).toEqual(ssoOidc)
    expect(JSON.stringify(config.ssoOidc)).toBe(JSON.stringify(ssoOidc))
  })
})
