import type { Locator } from '@playwright/test'

export interface FocusIndicator {
  focused: boolean
  focusVisible: boolean
  forcedColors: boolean
  outline: string
  width: number
  offset: number
  color: string
  alpha: number
  opacity: number
  visible: boolean
  unclipped: boolean
  unobscured: boolean
  transition: string
  animation: string
}

/** Observe styles and bounded visibility geometry; attach a render separately for visual review. */
export async function measureFocusIndicator(target: Locator): Promise<FocusIndicator> {
  return target.evaluate(async (element) => {
    // Observe settled style/layout frames, including reduced-motion transitions.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const reach = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset)
    const indicator = {
      left: rect.left - reach,
      right: rect.right + reach,
      top: rect.top - reach,
      bottom: rect.bottom + reach,
    }
    let opacity = Number.parseFloat(style.opacity)
    let unclipped =
      indicator.left >= 0 &&
      indicator.top >= 0 &&
      indicator.right <= innerWidth &&
      indicator.bottom <= innerHeight
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const ancestor = getComputedStyle(parent)
      opacity *= Number.parseFloat(ancestor.opacity)
      const box = parent.getBoundingClientRect()
      if (ancestor.clipPath !== 'none' || ancestor.maskImage !== 'none') unclipped = false
      if (
        ['hidden', 'clip', 'scroll', 'auto'].includes(ancestor.overflowX) &&
        (indicator.left < box.left || indicator.right > box.right)
      )
        unclipped = false
      if (
        ['hidden', 'clip', 'scroll', 'auto'].includes(ancestor.overflowY) &&
        (indicator.top < box.top || indicator.bottom > box.bottom)
      )
        unclipped = false
    }
    const points = [
      [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
      [rect.left + rect.width / 4, rect.top + rect.height / 4],
      [rect.right - rect.width / 4, rect.top + rect.height / 4],
      [rect.left + rect.width / 4, rect.bottom - rect.height / 4],
      [rect.right - rect.width / 4, rect.bottom - rect.height / 4],
    ]
    const unobscured = points.every(([x, y]) => {
      const top = document.elementFromPoint(x, y)
      return top === element || (top !== null && element.contains(top))
    })
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Focus color measurement needs a canvas context')
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = style.outlineColor
    context.fillRect(0, 0, 1, 1)
    return {
      focused: element === document.activeElement,
      focusVisible: element.matches(':focus-visible'),
      forcedColors: matchMedia('(forced-colors: active)').matches,
      outline: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      offset: Number.parseFloat(style.outlineOffset),
      color: style.outlineColor,
      alpha: context.getImageData(0, 0, 1, 1).data[3] / 255,
      opacity,
      unclipped,
      unobscured,
      visible:
        style.display !== 'none' &&
        style.visibility === 'visible' &&
        rect.width > 0 &&
        rect.height > 0,
      transition: style.transitionDuration,
      animation: style.animationDuration,
    }
  })
}

/** Our forced-colors Button contract is a focus-only, opaque, offset solid outline. */
export function assertForcedColorsFocus(before: FocusIndicator, after: FocusIndicator): void {
  if (before.focused || before.focusVisible) throw new Error('Focus baseline must be unfocused')
  if (!before.forcedColors || !after.forcedColors)
    throw new Error('Forced-colors media must be active')
  if (!after.focused || !after.focusVisible)
    throw new Error('Actual keyboard focus and focus-visible are required')
  if (
    !after.visible ||
    !after.unclipped ||
    !after.unobscured ||
    after.opacity !== 1 ||
    after.alpha !== 1 ||
    after.outline !== 'solid' ||
    !Number.isFinite(after.width) ||
    after.width < 2 ||
    !Number.isFinite(after.offset) ||
    after.offset < 2
  )
    throw new Error(
      'Focus indicator must be an opaque visible solid outline of at least 2px with 2px offset'
    )
  if (
    before.outline === after.outline &&
    before.width === after.width &&
    before.offset === after.offset &&
    before.color === after.color &&
    before.alpha === after.alpha
  )
    throw new Error(
      'Focus must change the indicator; a permanent border or outline is insufficient'
    )
}
