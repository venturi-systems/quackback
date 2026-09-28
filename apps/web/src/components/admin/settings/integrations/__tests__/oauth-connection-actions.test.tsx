// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OAuthConnectionActions } from '../oauth-connection-actions'

vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}) }))
vi.mock('@/lib/client/mutations', () => ({
  useDeleteIntegration: () => ({ isPending: false, mutate: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mount(getConnectUrl: () => Promise<string>) {
  return render(
    <OAuthConnectionActions
      isConnected={false}
      searchParamKey="github"
      getConnectUrl={getConnectUrl}
      displayName="GitHub"
      disconnectDescription="Disconnect GitHub"
    />
  )
}

describe('OAuth connection recovery', () => {
  it('ignores the old timeout after page restoration and a new connection attempt', async () => {
    vi.useFakeTimers()
    mount(() => new Promise<string>(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    fireEvent(window, new Event('pageshow'))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(screen.getByRole('button', { name: 'Connecting...' })).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('ignores a late connect URL from before the page was restored', async () => {
    let resolveRequest!: (url: string) => void
    mount(
      () =>
        new Promise<string>((resolve) => {
          resolveRequest = resolve
        })
    )
    const originalUrl = window.location.href
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent(window, new Event('pageshow'))
    await act(async () => resolveRequest('https://example.com/obsolete-oauth'))
    expect(window.location.href).toBe(originalUrl)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('restores the Connect button when the browser restores the page', async () => {
    vi.useFakeTimers()
    mount(() => new Promise<string>(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByRole('button', { name: 'Connecting...' })).toBeDisabled()
    fireEvent(window, new Event('pageshow'))
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
  })

  it('shows a visible error and permits retry after a rejected request', async () => {
    const getConnectUrl = vi.fn().mockRejectedValue(new Error('Server failure'))
    mount(getConnectUrl)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect' })))
    expect(screen.getByRole('alert')).toHaveTextContent('Please try again')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect' })))
    expect(getConnectUrl).toHaveBeenCalledTimes(2)
  })

  it('recovers from a request that never settles', async () => {
    vi.useFakeTimers()
    mount(() => new Promise<string>(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByRole('button', { name: 'Connecting...' })).toBeDisabled()
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to start the GitHub connection')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })
})
