// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { containsStyleEndTag, cssForStyleElement } from '../style-element-css'

/** Parse `<style>{text}</style>` the way a browser parses server-rendered HTML. */
function parseStyleElement(text: string) {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body><style>${text}</style><p>after</p></body></html>`,
    'text/html'
  )
  return {
    styles: [...doc.querySelectorAll('style')].map((el) => el.textContent),
    scripts: doc.querySelectorAll('script').length,
  }
}

const INJECTIONS = [
  'a { color: red }</style><script>window.__styleInjected = 1</script>',
  'a { color: red }</STYLE ><script>window.__styleInjected = 1</script>',
  ':root { --primary: red</style><script>1</script><style> }</style><img src=x onerror=alert(1)>',
]

// A browser also ends the element at `</style/` (the RAWTEXT end tag name
// state accepts a solidus), but happy-dom's parser does not, so this form is
// checked by the rewrite alone rather than by parsing it.
const SOLIDUS_INJECTION = 'a { color: red }</StYlE/><script>window.__styleInjected = 1</script>'

describe('cssForStyleElement', () => {
  it('leaves CSS without a </style sequence byte for byte unchanged', () => {
    const css = [
      '@media (width < 600px) { .a { color: red } }',
      '@container (400px <= width <= 700px) { .b > .c { margin: 0 } }',
      '.d::before { content: "<b>" }',
      '/* a < b */ .e { background: url(data:image/svg+xml,%3Csvg%3E) }',
    ].join('\n')
    expect(cssForStyleElement(css)).toBe(css)
  })

  it('rewrites every </style, in any letter case, and keeps the original case', () => {
    expect(cssForStyleElement('a</style>b</STYLE>c</StYlE>')).toBe(
      'a<\\/style>b<\\/STYLE>c<\\/StYlE>'
    )
    expect(cssForStyleElement(SOLIDUS_INJECTION)).toBe(
      'a { color: red }<\\/StYlE/><script>window.__styleInjected = 1</script>'
    )
  })

  it('keeps an injected end tag from closing the element once parsed as HTML', () => {
    for (const css of INJECTIONS) {
      // Without the rewrite the parser ends the element and runs the markup.
      expect(parseStyleElement(css).scripts).toBe(1)

      const safe = cssForStyleElement(css)
      const parsed = parseStyleElement(safe)
      expect(parsed.scripts).toBe(0)
      expect(parsed.styles).toEqual([safe])
    }
  })
})

describe('containsStyleEndTag', () => {
  it('detects </style in any letter case, on every call', () => {
    for (const css of [...INJECTIONS, SOLIDUS_INJECTION]) {
      expect(containsStyleEndTag(css)).toBe(true)
      expect(containsStyleEndTag(css)).toBe(true)
    }
  })

  it('accepts CSS whose only < is a comparison, a string or a comment', () => {
    expect(containsStyleEndTag('@media (width < 600px) { .a { color: red } }')).toBe(false)
    expect(containsStyleEndTag('.d::before { content: "<b>" } /* < / style */')).toBe(false)
    expect(containsStyleEndTag('')).toBe(false)
  })
})
