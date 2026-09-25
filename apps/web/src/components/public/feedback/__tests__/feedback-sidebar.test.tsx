// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it } from 'vitest'

import type { PublicBoardWithStats } from '@/lib/shared/types'
import { FeedbackSidebar } from '../feedback-sidebar'

function board(name: string, postCount: number): PublicBoardWithStats {
  return {
    id: `board_${postCount}`,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    postCount,
  } as unknown as PublicBoardWithStats
}

function renderSidebar() {
  return render(
    <IntlProvider locale="en" messages={{}}>
      <FeedbackSidebar
        boards={[board('Feature Requests', 127), board('Ideas', 1), board('Empty', 0)]}
        onBoardChange={() => undefined}
      />
    </IntlProvider>
  )
}

/** The button's text as the design suite checker reads it: .sr-only text excluded. */
function checkerText(element: Element): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let text = ''
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement?.closest('.sr-only')) {
      text += walker.currentNode.textContent
    }
  }
  return text.replace(/\s+/g, ' ').trim()
}

describe('FeedbackSidebar board buttons (REQ-32)', () => {
  it('names each board with its post count as a phrase, not a bare number run into the name', () => {
    renderSidebar()
    expect(screen.getByRole('button', { name: 'Feature Requests 127 posts' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ideas 1 post' })).toBeTruthy()
    // A board with no posts shows no count at all.
    expect(screen.getByRole('button', { name: 'Empty' })).toBeTruthy()
  })

  it('keeps the visible name and count apart in the text the render checker measures', () => {
    renderSidebar()
    const button = screen.getByRole('button', { name: /^Feature Requests/ })
    expect(checkerText(button)).toBe('Feature Requests 127')
  })
})
