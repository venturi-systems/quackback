// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { FeedbackToolbar } from '../feedback/feedback-toolbar'
import { PublicRoadmapToolbar } from '../public-roadmap-toolbar'

const toolbars = [
  { name: 'feedback' },
  { name: 'roadmap' },
]

describe.each(toolbars)('$name search', ({ name }) => {
  function toolbar(currentSearch?: string) {
    return (
      <IntlProvider locale="en" defaultLocale="en">
        {name === 'feedback' ? (
          <FeedbackToolbar
            currentSort="trending"
            onSortChange={vi.fn()}
            currentSearch={currentSearch}
            onSearchChange={vi.fn()}
          />
        ) : (
          <PublicRoadmapToolbar
            currentSort="votes"
            onSortChange={vi.fn()}
            currentSearch={currentSearch}
            onSearchChange={vi.fn()}
          />
        )}
      </IntlProvider>
    )
  }

  it('keeps an explicit visible label after typing', async () => {
    render(toolbar())
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const input = await screen.findByRole('textbox', { name: 'Search' })
    fireEvent.change(input, { target: { value: 'billing' } })
    expect(screen.getByLabelText('Search', { selector: 'input' })).toBe(input)
    expect(screen.getByText('Search', { selector: 'label' })).toBeVisible()
    expect(input).toHaveValue('billing')
  })

  it('follows external query changes and clearing', async () => {
    const { rerender } = render(toolbar('alpha'))
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const input = await screen.findByRole('textbox', { name: 'Search' })
    expect(input).toHaveValue('alpha')
    rerender(toolbar('beta'))
    expect(input).toHaveValue('beta')
    rerender(toolbar(undefined))
    expect(input).toHaveValue('')
  })
})

describe('FeedbackToolbar state', () => {
  it('exposes the selected sort and preserves a draft across unrelated renders', async () => {
    const onSortChange = vi.fn()
    const onSearchChange = vi.fn()
    function toolbar(sort: 'trending' | 'top', isLoading = false) {
      return (
        <IntlProvider locale="en" defaultLocale="en">
          <FeedbackToolbar
            currentSort={sort}
            onSortChange={onSortChange}
            currentSearch="saved"
            onSearchChange={onSearchChange}
            isLoading={isLoading}
          />
        </IntlProvider>
      )
    }
    const { rerender } = render(toolbar('trending'))
    expect(screen.getByRole('button', { name: 'Trending', pressed: true })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Top', pressed: false }))
    expect(onSortChange).toHaveBeenCalledWith('top')
    rerender(toolbar('top'))
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Top', pressed: true })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const input = await screen.findByRole('textbox', { name: 'Search' })
    fireEvent.change(input, { target: { value: 'unsent draft' } })
    rerender(toolbar('top', true))
    expect(input).toHaveValue('unsent draft')
    expect(onSearchChange).not.toHaveBeenCalled()
    fireEvent.submit(input.closest('form')!)
    expect(onSearchChange).toHaveBeenCalledWith('unsent draft')
  })
})
