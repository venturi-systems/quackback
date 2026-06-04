import { describe, it, expect } from 'vitest'
import { normalizeChatTagInput } from '../chat-tag.service'

describe('normalizeChatTagInput', () => {
  it('trims the name and defaults the color', () => {
    expect(normalizeChatTagInput({ name: '  Lead ' })).toEqual({ name: 'Lead', color: '#6b7280' })
  })

  it('keeps a valid custom hex color', () => {
    expect(normalizeChatTagInput({ name: 'x', color: '#FF0000' })).toEqual({
      name: 'x',
      color: '#FF0000',
    })
  })

  it('rejects an empty / whitespace name', () => {
    expect(() => normalizeChatTagInput({ name: '   ' })).toThrow()
  })

  it('rejects a name over 50 characters', () => {
    expect(() => normalizeChatTagInput({ name: 'a'.repeat(51) })).toThrow()
  })

  it('rejects a non-hex color', () => {
    expect(() => normalizeChatTagInput({ name: 'x', color: 'red' })).toThrow()
    expect(() => normalizeChatTagInput({ name: 'x', color: '#FFF' })).toThrow()
  })
})
