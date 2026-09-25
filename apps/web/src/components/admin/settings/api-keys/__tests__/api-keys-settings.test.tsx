// @vitest-environment happy-dom
/**
 * The API keys settings page is the administrator's notice for keys that
 * migration 9003_venturi_legacy_api_key_bounds limited to reading
 * (landing-page#2309, DEF-15): the migration gives each such key an expiry,
 * and this page is where an administrator learns to replace it first.
 *
 * Covers:
 *   - the notice above the list, singular and plural, and its absence when
 *     no key was bounded;
 *   - the line on each bounded key (the UTC date it was limited, and that it
 *     must be replaced before it expires), on that key only, in a colour that
 *     meets 4.5:1 on the card;
 *   - the scopes a key stored without any works with (read only);
 *   - the rotate dialog: a key stored without scopes or an expiry, or an
 *     expired key, is replaced instead of rotated (the server refuses both
 *     too: api-key-scopes-storage.test.ts), and a bounded key still rotates.
 *
 * The server functions, the router and the query client are mocked so the
 * test covers only what the page and the dialog render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

const invalidate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate }),
}))

const invalidateQueries = vi.fn()
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}))

const rotateApiKeyFn = vi.fn()
vi.mock('@/lib/server/functions/api-keys', () => ({
  createApiKeyFn: vi.fn(),
  revokeApiKeyFn: vi.fn(),
  rotateApiKeyFn: (...args: unknown[]) => rotateApiKeyFn(...args),
}))

import { ApiKeysSettings } from '../api-keys-settings'
import { RotateApiKeyDialog } from '../rotate-api-key-dialog'
import { API_KEY_ROTATION_BLOCKED_MESSAGES } from '@/lib/shared/api-key-scopes'
import type { ApiKey } from '@/lib/shared/types'

const DAY_MS = 24 * 60 * 60 * 1000
const BOUNDED_AT = new Date('2026-09-25T03:00:00.000Z')

function makeKey(name: string, overrides: Partial<ApiKey> = {}): ApiKey {
  const now = Date.now()
  return {
    id: `api_key_${name.toLowerCase().replace(/[^a-z0-9]/g, '')}` as ApiKey['id'],
    name,
    keyPrefix: 'qb_test',
    createdById: null,
    principalId: 'principal_service' as ApiKey['principalId'],
    lastUsedAt: new Date(now - DAY_MS),
    expiresAt: new Date(now + 90 * DAY_MS),
    createdAt: new Date(now - 400 * DAY_MS),
    revokedAt: null,
    legacyBoundedAt: null,
    scopes: ['read:feedback', 'write:feedback'],
    ...overrides,
  }
}

/** A key the migration found without scopes or an expiry, as it stored it. */
function boundedKey(name: string): ApiKey {
  return makeKey(name, {
    scopes: ['read:feedback', 'read:article'],
    expiresAt: new Date(Date.now() + 90 * DAY_MS),
    legacyBoundedAt: BOUNDED_AT,
  })
}

/** A key stored without scopes or an expiry that the migration never saw. */
function unboundedLegacyKey(name: string): ApiKey {
  return makeKey(name, { scopes: null, expiresAt: null, createdAt: new Date(Date.now() - DAY_MS) })
}

beforeEach(() => {
  invalidate.mockReset()
  invalidateQueries.mockReset()
  rotateApiKeyFn.mockReset()
})

describe('ApiKeysSettings: keys the legacy migration bounded', () => {
  it('shows the notice and a line on the bounded key only', () => {
    render(<ApiKeysSettings apiKeys={[boundedKey('Gateway reader'), makeKey('Zapier sync')]} />)

    const notice = screen.getByTestId('api-keys-legacy-notice')
    expect(notice).toHaveTextContent('1 key was created before keys needed scopes and an expiry')
    expect(notice).toHaveTextContent(
      'They can now only read feedback and help articles, and each stops working on the date shown.'
    )

    const lines = screen.getAllByTestId('api-key-legacy-bound')
    expect(lines).toHaveLength(1)
    expect(lines[0].textContent).toBe(
      'Limited to reading on 2026-09-25 because it was created before keys needed scopes and an expiry. Replace it before it expires.'
    )
    // The line sits with the bounded key's name, not with the other key.
    const row = lines[0].parentElement as HTMLElement
    expect(within(row).getByText('Gateway reader')).toBeTruthy()
    expect(within(row).queryByText('Zapier sync')).toBeNull()
  })

  it('draws the bounded-key line in amber-700, which meets 4.5:1 on the card', () => {
    render(<ApiKeysSettings apiKeys={[boundedKey('Gateway reader')]} />)

    // amber-600 measured 3.0:1 on the card (#f7f9fa); amber-700 measures 4.8:1.
    const line = screen.getByTestId('api-key-legacy-bound')
    expect(line.className).toContain('text-amber-700')
    expect(line.className).not.toContain('text-amber-600')
  })

  it('counts every bounded key in the notice', () => {
    render(
      <ApiKeysSettings
        apiKeys={[boundedKey('Gateway reader'), boundedKey('Nightly export'), makeKey('Zapier')]}
      />
    )

    expect(screen.getByTestId('api-keys-legacy-notice')).toHaveTextContent(
      '2 keys were created before keys needed scopes and an expiry'
    )
    expect(screen.getAllByTestId('api-key-legacy-bound')).toHaveLength(2)
  })

  it('shows no notice and no line when no key was bounded', () => {
    render(<ApiKeysSettings apiKeys={[makeKey('Zapier sync')]} />)

    expect(screen.queryByTestId('api-keys-legacy-notice')).toBeNull()
    expect(screen.queryAllByTestId('api-key-legacy-bound')).toHaveLength(0)
  })

  it('lists the stored read-only scopes of a bounded key', () => {
    render(<ApiKeysSettings apiKeys={[boundedKey('Gateway reader')]} />)

    expect(screen.getByTestId('api-key-scopes').textContent).toBe(
      'Scopes: read:feedback, read:article'
    )
  })

  it('lists the read-only scopes a key stored without any works with', () => {
    render(<ApiKeysSettings apiKeys={[unboundedLegacyKey('Old script')]} />)

    expect(screen.getByTestId('api-key-scopes').textContent).toBe(
      'Scopes: read:feedback, read:article (created before keys had scopes)'
    )
    expect(screen.getByText(/\(created before expiry was required\)/)).toBeTruthy()
  })
})

describe('RotateApiKeyDialog: keys that are replaced instead of rotated', () => {
  function renderDialog(apiKey: ApiKey) {
    return render(
      <RotateApiKeyDialog open onOpenChange={() => {}} apiKey={apiKey} onKeyRotated={() => {}} />
    )
  }

  it('offers no rotation for a key stored without scopes or an expiry', () => {
    renderDialog(unboundedLegacyKey('Old script'))

    expect(screen.getByText('Replace this key instead')).toBeTruthy()
    expect(screen.getByText(API_KEY_ROTATION_BLOCKED_MESSAGES.legacy)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rotate Key' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(rotateApiKeyFn).not.toHaveBeenCalled()
  })

  it('offers no rotation for an expired key', () => {
    renderDialog(makeKey('Expired sync', { expiresAt: new Date(Date.now() - DAY_MS) }))

    expect(screen.getByText('Replace this key instead')).toBeTruthy()
    expect(screen.getByText(API_KEY_ROTATION_BLOCKED_MESSAGES.expired)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rotate Key' })).toBeNull()
  })

  it('rotates a key the migration bounded, which stores scopes and an expiry', () => {
    renderDialog(boundedKey('Gateway reader'))

    expect(screen.queryByText('Replace this key instead')).toBeNull()
    expect(screen.getByText('The old key will stop working immediately')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rotate Key' })).toBeTruthy()
  })
})
