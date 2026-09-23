import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Tailwind v4 composes a shadow utility and the focus ring into one list:
//   box-shadow: var(--tw-inset-shadow), ..., var(--tw-ring-shadow), var(--tw-shadow)
// with --tw-shadow: var(--shadow-xs). A theme that sets --shadow-xs to `none`
// makes the list invalid, so the browser drops the whole declaration and every
// element using shadow-xs (primary buttons, inputs) loses its keyboard focus
// ring. "No shadow" must be a transparent zero shadow such as `0 0 #0000`.
const STYLE_FILES = ['venturi-theme.css', 'venturi-dark.css', '../globals.css']

describe('theme shadow tokens', () => {
  for (const file of STYLE_FILES) {
    it(`${file} never sets a Tailwind --shadow-* token to none`, () => {
      const css = readFileSync(path.resolve(__dirname, '..', file), 'utf8')
      const offenders = [...css.matchAll(/(--shadow(?:-[a-z0-9]+)?)\s*:\s*none\s*[;}]/g)].map(
        (m) => m[1]
      )
      expect(offenders).toEqual([])
    })
  }

  it('keeps a transparent zero shadow for the extra-small steps', () => {
    const css = readFileSync(path.resolve(__dirname, '..', 'venturi-theme.css'), 'utf8')
    expect(css).toMatch(/--shadow-xs:\s*0 0 #0000;/)
    expect(css).toMatch(/--shadow-2xs:\s*0 0 #0000;/)
  })
})
