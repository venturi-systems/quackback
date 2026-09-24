import { describe, expect, it } from 'vitest'
import { likeText } from '../like-pattern'

describe('likeText', () => {
  it('leaves text without pattern characters unchanged', () => {
    expect(likeText('example.com')).toBe('example.com')
    expect(likeText('')).toBe('')
  })

  it('escapes the wildcards so they match themselves', () => {
    expect(likeText('50%_off')).toBe('50\\%\\_off')
  })

  it('escapes the escape character, so a trailing backslash cannot end the pattern', () => {
    expect(likeText('a\\')).toBe('a\\\\')
    expect(likeText('\\%')).toBe('\\\\\\%')
  })
})
