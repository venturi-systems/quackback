import { describe, expect, it } from 'vitest'
import {
  assertForcedColorsFocus,
  type FocusIndicator,
} from '../apps/web/e2e/utils/forced-colors-focus'

const baseline = (): FocusIndicator => ({
  focused: false,
  focusVisible: false,
  forcedColors: true,
  outline: 'none',
  width: 0,
  offset: 0,
  color: 'rgb(0, 0, 0)',
  alpha: 1,
  opacity: 1,
  visible: true,
  unclipped: true,
  unobscured: true,
  transition: '0s',
  animation: '0s',
})
const focused = (): FocusIndicator => ({
  ...baseline(),
  focused: true,
  focusVisible: true,
  outline: 'solid',
  width: 2,
  offset: 2,
})

describe('forced-colors focus evidence', () => {
  it('accepts an opaque focus-only outline under keyboard focus', () => {
    expect(() => assertForcedColorsFocus(baseline(), focused())).not.toThrow()
  })
  it.each([
    ['outline removed while focus remains', { outline: 'none' }],
    ['zero width', { width: 0 }],
    ['subcontract width', { width: 1 }],
    ['invalid width', { width: Number.NaN }],
    ['no offset', { offset: 0 }],
    ['invalid offset', { offset: Number.NaN }],
    ['transparent paint', { alpha: 0 }],
    ['translucent paint', { alpha: 0.5 }],
    ['transparent element', { opacity: 0 }],
    ['hidden element', { visible: false }],
    ['clipped outline', { unclipped: false }],
    ['covered element', { unobscured: false }],
    ['no actual focus', { focused: false }],
    ['no keyboard indicator', { focusVisible: false }],
    ['wrong media', { forcedColors: false }],
  ] as const)('rejects %s', (_name, change) => {
    expect(() => assertForcedColorsFocus(baseline(), { ...focused(), ...change })).toThrow()
  })
  it('rejects a permanent outline despite valid dimensions and focus', () => {
    const before = { ...focused(), focused: false, focusVisible: false }
    expect(() => assertForcedColorsFocus(before, focused())).toThrow('Focus must change')
  })
  it('rejects an already-focused baseline', () => {
    expect(() => assertForcedColorsFocus(focused(), focused())).toThrow('baseline')
  })
  it('rejects a baseline from different media', () => {
    expect(() =>
      assertForcedColorsFocus({ ...baseline(), forcedColors: false }, focused())
    ).toThrow('media')
  })
})
