import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Suite v6.6: "Do not shrink below minimum type." The smallest type token is
 * 12px (--ds-primitive-font-size-12), so the portal never sets an arbitrary
 * 9, 10 or 11px size. Tailwind's text-xs is the 12px step. These views have
 * no render harness for every state, so this test reads their source.
 */
const SRC = path.resolve(__dirname, '..', '..')

/** The public portal: its routes and the components only it renders. */
const PORTAL_ROOTS = [
  'routes/_portal',
  'routes/_portal.tsx',
  'components/public',
  'components/portal',
  'components/notifications',
  'components/help-center',
]

/**
 * Reviewed remainder, by file and count. The "About Venturi" sidebar link is
 * being rewritten by the open navigation change (quackback #200); it moves to
 * 12px with that change or right after it.
 */
const REVIEWED: Record<string, number> = {
  'components/public/feedback/feedback-sidebar.tsx': 1,
}

const BELOW_MINIMUM = /\btext-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g

function sourceFiles(entry: string): string[] {
  const full = path.join(SRC, entry)
  if (statSync(full).isFile()) return [entry]
  return readdirSync(full).flatMap((name) =>
    name === '__tests__' ? [] : sourceFiles(path.join(entry, name))
  )
}

describe('portal type is never below the 12px minimum (v6.6)', () => {
  const files = PORTAL_ROOTS.flatMap(sourceFiles).filter((file) => /\.tsx?$/.test(file))

  it('reads the portal sources', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('sets no arbitrary 9, 10 or 11px type outside the reviewed remainder', () => {
    const found: Record<string, number> = {}
    for (const file of files) {
      const count = (readFileSync(path.join(SRC, file), 'utf8').match(BELOW_MINIMUM) ?? []).length
      if (count > 0) found[file.split(path.sep).join('/')] = count
    }
    expect(found).toEqual(REVIEWED)
  })
})
