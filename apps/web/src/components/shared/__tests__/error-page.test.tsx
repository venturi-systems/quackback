// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DefaultErrorPage, errorMessage } from '../error-page'

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

    expect(screen.getByText('Something went wrong.')).toBeInTheDocument()
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument()
  })
})
