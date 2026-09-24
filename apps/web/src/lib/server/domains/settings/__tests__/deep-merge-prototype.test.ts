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
import { DEFAULT_AUTH_CONFIG, DEFAULT_PORTAL_CONFIG } from '../settings.types'

const PROBE = 'def40Polluted'

function objectPrototypeIsClean(): boolean {
  return !Object.prototype.hasOwnProperty.call(Object.prototype, PROBE) && !(PROBE in {})
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

  it('still returns the defaults for a stored JSON null', () => {
    expect(parseJsonConfig('null', DEFAULT_AUTH_CONFIG)).toEqual(DEFAULT_AUTH_CONFIG)
  })
})
