import { describe, it, expect } from 'vitest'
import { tiptapContentSchema } from '../posts'

describe('tiptapContentSchema', () => {
  it('accepts link marks with null title attribute', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Check out ' },
            {
              type: 'text',
              text: 'https://example.com',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com',
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                    class: null,
                    title: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const result = tiptapContentSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('accepts link marks without optional attrs', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a link',
              marks: [
                {
                  type: 'link',
                  attrs: { href: 'https://example.com' },
                },
              ],
            },
          ],
        },
      ],
    }
    const result = tiptapContentSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('rejects mark attrs with non-primitive values', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'bad',
              marks: [
                {
                  type: 'bold',
                  attrs: { evil: { nested: 'object' } },
                },
              ],
            },
          ],
        },
      ],
    }
    const result = tiptapContentSchema.safeParse(input)
    expect(result.success).toBe(false)
  })
})
