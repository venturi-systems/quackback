import { describe, expect, it } from 'vitest'
import { contentPreview } from '../string'
import { inboxContentPreview, INBOX_PREVIEW_MAX_LENGTH } from '../inbox-preview'

describe('inboxContentPreview', () => {
  it.each([
    '<p>Hello <strong>world</strong></p>',
    '# Heading\n**bold** *italic* `code`\n1. first\n- second',
    'Visit [a link](https://example.com/path?q=1) after ![image](https://example.com/i.png)',
    '<img src="https://example.com/i.png" alt="photo"> caption',
    '&amp;lt;literal&amp;gt; and &lt;b&gt;text&lt;/b&gt;',
    'Unicode: 🦆 👩🏽‍💻 e\u0301 漢字',
    '  spaces\tand\nnewlines  ',
    '',
  ])('retains the existing normalized excerpt for %j', (content) => {
    expect(inboxContentPreview(content)).toBe(contentPreview(content))
  })

  it('normalizes the whole document before truncation', () => {
    const content = `<a href="https://example.com/${'path'.repeat(500)}">Visible link</a> **${'a'.repeat(400)}**`
    expect(inboxContentPreview(content)).toBe(contentPreview(content, INBOX_PREVIEW_MAX_LENGTH))
    expect(inboxContentPreview(content)).toHaveLength(INBOX_PREVIEW_MAX_LENGTH + 3)
  })

  it.each(['🦆', '👩🏽‍💻', 'e\u0301'])('does not split the boundary grapheme %s', (grapheme) => {
    const prefix = 'a'.repeat(INBOX_PREVIEW_MAX_LENGTH - 1)
    expect(inboxContentPreview(prefix + grapheme + 'after')).toBe(prefix + '...')
  })

  it('bounds even one grapheme with thousands of combining characters', () => {
    expect(inboxContentPreview('e' + '\u0301'.repeat(5_000))).toBe('...')
  })
})
