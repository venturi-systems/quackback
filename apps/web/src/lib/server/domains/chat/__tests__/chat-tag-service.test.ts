import { describe, it, expect } from 'vitest'
import type { ChatTagId } from '@quackback/ids'
import { normalizeChatTagInput, hasNameConflict } from '../chat-tag.service'

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

describe('hasNameConflict', () => {
  const id = (s: string) => s as ChatTagId
  const live = [
    { id: id('chat_tag_a'), name: 'Lead' },
    { id: id('chat_tag_b'), name: 'VIP' },
  ]

  it('flags a rename onto another live tag (case-insensitive)', () => {
    expect(hasNameConflict(id('chat_tag_a'), 'vip', live)).toBe(true)
    expect(hasNameConflict(id('chat_tag_a'), '  VIP ', live)).toBe(true)
  })

  it('allows keeping the same tag at its own name', () => {
    // Renaming a tag to (a casing of) its own current name is not a conflict.
    expect(hasNameConflict(id('chat_tag_b'), 'VIP', live)).toBe(false)
    expect(hasNameConflict(id('chat_tag_b'), 'vip', live)).toBe(false)
  })

  it('allows a brand-new name', () => {
    expect(hasNameConflict(id('chat_tag_a'), 'Churned', live)).toBe(false)
  })
})
