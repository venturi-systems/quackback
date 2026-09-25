// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { MotionConfigContext } from 'framer-motion'
import { useContext } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Framer Motion caches the media query in module state, so the preference is
// stubbed at the hook; MotionConfig and its context stay the real ones.
const preference = vi.hoisted(() => ({ reduce: null as boolean | null }))
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => preference.reduce,
}))

import { ReducedMotionConfig } from '../reduced-motion-config'

function Probe() {
  const { skipAnimations } = useContext(MotionConfigContext)
  return <output data-testid="skip">{String(skipAnimations)}</output>
}

function skipAnimationsWhen(reduce: boolean | null) {
  preference.reduce = reduce
  const { unmount } = render(
    <ReducedMotionConfig>
      <Probe />
    </ReducedMotionConfig>
  )
  const value = screen.getByTestId('skip').textContent
  unmount()
  return value
}

describe('ReducedMotionConfig', () => {
  it('skips every Framer Motion animation when the reader prefers reduced motion', () => {
    expect(skipAnimationsWhen(true)).toBe('true')
  })

  it('leaves animations on when the reader does not', () => {
    expect(skipAnimationsWhen(false)).not.toBe('true')
  })

  it('leaves animations on while the preference is unknown (server render)', () => {
    expect(skipAnimationsWhen(null)).not.toBe('true')
  })
})
