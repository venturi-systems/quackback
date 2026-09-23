import { describe, expect, it } from 'vitest'
import { sourceCodeUrl } from '../venturi-identity'

describe('sourceCodeUrl (AGPL-3.0 section 13 source link)', () => {
  it('links the exact commit when the build recorded one', () => {
    expect(sourceCodeUrl('7121d6396')).toBe(
      'https://github.com/venturi-systems/quackback/tree/7121d6396'
    )
    expect(sourceCodeUrl('7121d6396d0bcced8f289b97f2e1b861bbfd0b77')).toBe(
      'https://github.com/venturi-systems/quackback/tree/7121d6396d0bcced8f289b97f2e1b861bbfd0b77'
    )
  })

  it('falls back to the repository for a missing or malformed commit', () => {
    for (const commit of [null, undefined, '', 'unknown', 'abc', 'main', '../evil', 'ABCDEF1']) {
      expect(sourceCodeUrl(commit)).toBe('https://github.com/venturi-systems/quackback')
    }
  })
})
