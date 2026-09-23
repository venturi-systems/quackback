// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DefaultErrorPage, NotFoundPage, errorMessage } from '../error-page'
import { InShell } from '@/components/public/shell/shell-context'

// TanStack Router types a caught route error as `unknown`, so the error page and
// the admin route error components read the message through errorMessage().
describe('errorMessage', () => {
  it('reads the message of an Error or of any object carrying a string message', () => {
    expect(errorMessage(new Error('Board not found'))).toBe('Board not found')
    expect(errorMessage({ message: 'Server function failed' })).toBe('Server function failed')
  })

  it('returns undefined for thrown values that carry no string message', () => {
    expect(errorMessage('boom')).toBeUndefined()
    expect(errorMessage(null)).toBeUndefined()
    expect(errorMessage(undefined)).toBeUndefined()
    expect(errorMessage({ message: 42 })).toBeUndefined()
  })
})

describe('DefaultErrorPage', () => {
  it('shows the technical details of a caught Error', () => {
    render(<DefaultErrorPage error={new Error('Board not found')} />)

    expect(screen.getByText('Technical details')).toBeInTheDocument()
    expect(screen.getByText('Board not found')).toBeInTheDocument()
  })

  it('renders without details, instead of crashing, when the thrown value is not an Error', () => {
    render(<DefaultErrorPage error={null} />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'This page could not load' })
    ).toBeInTheDocument()
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument()
  })

  it('offers Try again only when the router can reset the route', () => {
    const { unmount } = render(<DefaultErrorPage error={null} />)
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    unmount()

    render(<DefaultErrorPage error={null} reset={() => {}} />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('names the condition in the page title', () => {
    render(<DefaultErrorPage error={null} />)
    expect(document.title).toBe('Page could not load · Venturi Feedback')
  })
})

describe('NotFoundPage', () => {
  it('stands alone as a full public page: header, main landmark and footer', () => {
    render(<NotFoundPage />)

    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Venturi home' })).toHaveAttribute(
      'href',
      'https://venturi.systems/'
    )
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to feedback home' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Go to venturi.systems' })).toHaveAttribute(
      'href',
      'https://venturi.systems/'
    )
    expect(document.title).toBe('Page not found · Venturi Feedback')
  })

  it('draws no second header or footer inside a layout that already has them', () => {
    render(
      <InShell>
        <NotFoundPage />
      </InShell>
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Venturi home' })).not.toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(screen.queryByRole('main')).not.toBeInTheDocument()
  })
})
