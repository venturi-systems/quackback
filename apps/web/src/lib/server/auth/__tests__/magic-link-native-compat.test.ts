// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { magicLink } from 'better-auth/plugins'

const state = vi.hoisted(() => ({
  auth: undefined as ReturnType<typeof createFixtureAuth> | undefined,
  rows: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('../index', () => ({
  getAuth: async () => {
    if (!state.auth) throw new Error('Missing isolated auth fixture')
    return state.auth
  },
}))
vi.mock('@/lib/server/db', () => ({
  verification: { identifier: 'identifier' },
  inArray: (_column: unknown, identifiers: string[]) => identifiers,
  db: {
    delete: () => ({
      where: async (identifiers: string[]) => {
        state.rows.verification = state.rows.verification.filter(
          (row) => !identifiers.includes(String(row.identifier))
        )
      },
    }),
  },
}))

const { mintMagicLinkUrl, revokeMagicLinkToken, revokeMagicLinkTokens } =
  await import('../magic-link-mint')
const origin = 'https://magic-link-regression.invalid'
const recipient = 'owner@example.com'
const options = { email: recipient, callbackPath: '/admin', portalUrl: origin }

function createFixtureAuth(rows: Record<string, Record<string, unknown>[]>) {
  return betterAuth({
    baseURL: origin,
    secret: 'isolated-magic-link-regression-secret-0123456789',
    database: memoryAdapter(rows),
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    plugins: [magicLink({ sendMagicLink: async () => {} })],
  })
}

beforeEach(() => {
  state.rows = { user: [], account: [], session: [], verification: [] }
  state.auth = createFixtureAuth(state.rows)
})

async function verify(token: string) {
  return state.auth!.handler(
    new Request(
      `${origin}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent('/admin')}`
    )
  )
}

describe('custom magic links against the installed Better Auth verification endpoint', () => {
  it('consumes a custom invitation once and issues a session for the intended recipient', async () => {
    const { token } = await mintMagicLinkUrl(options)
    const response = await verify(token)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${origin}/admin`)
    expect(response.headers.get('set-cookie')).toContain('session_token=')
    expect(state.rows.user).toHaveLength(1)
    expect(state.rows.user[0].email).toBe(recipient)
    expect(state.rows.session).toHaveLength(1)

    const replay = await verify(token)
    expect(new URL(replay.headers.get('location')!).searchParams.get('error')).toBe('INVALID_TOKEN')
    expect(state.rows.session).toHaveLength(1)
  })

  it('revokes current and legacy storage identifiers without revoking another invitation', async () => {
    const first = await mintMagicLinkUrl(options)
    const second = await mintMagicLinkUrl(options)
    state.rows.verification.push({
      id: 'legacy-retained-row',
      identifier: first.token,
      value: JSON.stringify({ email: recipient, attempt: 0 }),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await revokeMagicLinkToken(first.token)
    expect(state.rows.verification.some((row) => row.identifier === first.token)).toBe(false)
    const revoked = await verify(first.token)
    expect(new URL(revoked.headers.get('location')!).searchParams.get('error')).toBe(
      'INVALID_TOKEN'
    )
    expect((await verify(second.token)).headers.get('location')).toBe(`${origin}/admin`)
  })

  it('bulk cancellation rejects every cancelled link and expired custom links remain invalid', async () => {
    const first = await mintMagicLinkUrl(options)
    const second = await mintMagicLinkUrl(options)
    await revokeMagicLinkTokens([first.token, second.token])
    for (const token of [first.token, second.token]) {
      const response = await verify(token)
      expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe(
        'INVALID_TOKEN'
      )
    }
    const expired = await mintMagicLinkUrl({ ...options, expiresInSeconds: -1 })
    const response = await verify(expired.token)
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe(
      'INVALID_TOKEN'
    )
    expect(state.rows.session).toHaveLength(0)
  })
})
