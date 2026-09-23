import { describe, it, expect } from 'vitest'
import { ownMessage } from '../own-message'

const TABLE: Record<string, string> = { known: 'A known message.' }

describe('ownMessage', () => {
  it('returns the message for an own key', () => {
    expect(ownMessage(TABLE, 'known')).toBe('A known message.')
  })

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'never resolves the inherited Object.prototype member %s',
    (key) => {
      expect(ownMessage(TABLE, key)).toBeNull()
    }
  )

  it('returns null for an unknown, empty or missing key', () => {
    expect(ownMessage(TABLE, 'made_up')).toBeNull()
    expect(ownMessage(TABLE, '')).toBeNull()
    expect(ownMessage(TABLE, null)).toBeNull()
    expect(ownMessage(TABLE, undefined)).toBeNull()
  })

  it('returns null when an own key holds something other than a string', () => {
    const odd = { weird: 42 } as unknown as Record<string, string>
    expect(ownMessage(odd, 'weird')).toBeNull()
  })
})
