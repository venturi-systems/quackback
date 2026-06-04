import { describe, it, expect } from 'vitest'
import { DEFAULT_FEATURE_FLAGS, LAB_SECTIONS, FEATURE_FLAG_REGISTRY } from '../settings.types'

describe('LAB_SECTIONS', () => {
  it('assigns every feature flag to exactly one section', () => {
    const sectioned = LAB_SECTIONS.flatMap((s) => s.flags)
    // No flag appears twice...
    expect(new Set(sectioned).size).toBe(sectioned.length)
    // ...and the set of sectioned flags is exactly the full flag set, so a new
    // flag can never silently go unsurfaced on the Labs page.
    expect([...sectioned].sort()).toEqual(Object.keys(DEFAULT_FEATURE_FLAGS).sort())
  })

  it('only references flags that exist in the registry', () => {
    for (const section of LAB_SECTIONS) {
      for (const flag of section.flags) {
        expect(FEATURE_FLAG_REGISTRY[flag]).toBeDefined()
      }
    }
  })
})
