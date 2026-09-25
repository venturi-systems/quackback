// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it, vi } from 'vitest'

import { RoadmapColumnsScrollButton } from '../roadmap-columns-scroll-button'

function renderButton(direction: 'left' | 'right', onScroll = vi.fn()) {
  render(
    <IntlProvider locale="en" messages={{}}>
      <RoadmapColumnsScrollButton direction={direction} onScroll={onScroll} />
    </IntlProvider>
  )
  return onScroll
}

describe('RoadmapColumnsScrollButton (REQ-31: focus stays on screen)', () => {
  it.each([
    ['left', 'Scroll columns left'],
    ['right', 'Scroll columns right'],
  ] as const)('scrolls the columns %s from one named button', (direction, name) => {
    const onScroll = renderButton(direction)
    fireEvent.click(screen.getByRole('button', { name }))
    expect(onScroll).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it.each([
    ['left', 'Scroll columns left'],
    ['right', 'Scroll columns right'],
  ] as const)(
    'keeps the %s button one touch target, not the full-height fade',
    (direction, name) => {
      renderButton(direction)
      const button = screen.getByRole('button', { name })
      // A board 3,110px tall made the old full-height button a 64x3,110 focus
      // target whose chevron sat off screen (render check run 36091574101).
      expect(button.className).toMatch(/\bsize-11\b/)
      expect(button.className).not.toMatch(/\b(top-0|bottom-4|h-full)\b/)
      // Equal sticky insets hold it at the middle of the screen while the
      // board passes behind it.
      expect(button.className).toMatch(/\bsticky\b/)
      expect(button.className).toContain('top-[calc(50svh-1.375rem)]')
      expect(button.className).toContain('bottom-[calc(50svh-1.375rem)]')
      expect(button.className).toMatch(/\bpointer-events-auto\b/)
      // The fade keeps the board's full height but takes no pointer events,
      // and it holds no text, so it needs no accessible name of its own.
      const fade = button.parentElement!
      expect(fade.className).toMatch(/\bpointer-events-none\b/)
      expect(fade.className).toMatch(/\btop-0\b/)
      expect(fade.className).toMatch(/\bbottom-4\b/)
      expect(fade).not.toHaveAttribute('aria-hidden')
      expect(fade.textContent).toBe('')
    }
  )
})
