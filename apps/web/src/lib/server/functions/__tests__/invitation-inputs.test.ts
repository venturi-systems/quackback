import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'

// DEF-45: the team and portal invitation pages read an invitation id from the
// link, and their server functions are reachable before the caller has a
// member record. The invitation id column takes only an invite TypeID, so any
// other value names an invitation that cannot exist. The page reads answer it
// as not found without a query; the writes refuse it at the validator.

type InputSchema = { safeParse(value: unknown): { success: boolean } }
type Handler = (args: { data: unknown }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  inputs: new Map<unknown, InputSchema | undefined>(),
  findInvitation: vi.fn(),
  findSettings: vi.fn(),
  getSession: vi.fn(),
}))

vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    let input: InputSchema | undefined
    const chain = {
      validator(schema: InputSchema) {
        input = schema
        return chain
      },
      handler(fn: unknown) {
        hoisted.inputs.set(fn, input)
        return fn
      },
    }
    return chain
  },
}))
vi.mock('@tanstack/react-start/server', () => ({ getRequestHeaders: () => new Headers() }))
vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      invitation: { findFirst: hoisted.findInvitation },
      settings: { findFirst: hoisted.findSettings },
    },
  },
  invitation: {},
  principal: {},
  user: {},
  and: vi.fn(),
  eq: vi.fn(),
  gt: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}))
vi.mock('@/lib/server/storage/s3', () => ({ getPublicUrlOrNull: () => null }))
vi.mock('@/lib/server/auth/session', () => ({ getSession: hoisted.getSession }))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getPublicAuthConfig: async () => ({ oauth: { password: true } }),
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/server/functions/invitation-magic-link', () => ({
  appendInviteMagicLinkToken: vi.fn(),
  removeInviteMagicLinkToken: vi.fn(),
}))
vi.mock('@/lib/server/audit/log', () => ({ actorFromAuth: vi.fn(), recordAuditEvent: vi.fn() }))
vi.mock('@/lib/server/config', () => ({ getBaseUrl: () => 'https://feedback.example.com' }))
vi.mock('@quackback/email', () => ({ sendPortalInviteEmail: vi.fn() }))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))

import { acceptInvitationFn, getInvitationDetailsFn, getInviteBrandingFn } from '../invitations'
import { acceptPortalInviteFn } from '../portal-invites'

const INVITE = generateId('invite')
const NOT_FOUND = /could not be found/

function inputOf(fn: unknown): InputSchema {
  const schema = hoisted.inputs.get(fn)
  if (!schema) throw new Error('server function has no validator')
  return schema
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.findSettings.mockResolvedValue({ name: 'Acme', logoKey: null })
  hoisted.findInvitation.mockResolvedValue({ inviter: { name: 'Ann' } })
  hoisted.getSession.mockResolvedValue({
    user: { id: generateId('user'), email: 'new@acme.example', createdAt: new Date() },
  })
})

describe('getInviteBrandingFn', () => {
  const branding = getInviteBrandingFn as unknown as Handler

  it.each(['garbage', 'invite_1', generateId('post'), ''])(
    'answers %j with the workspace branding and no invitation query',
    async (id) => {
      expect(await branding({ data: id })).toEqual({
        workspaceName: 'Acme',
        logoUrl: null,
        inviterName: null,
      })
      expect(hoisted.findInvitation).not.toHaveBeenCalled()
    }
  )

  it('looks up a well-formed invite id', async () => {
    expect(await branding({ data: INVITE })).toMatchObject({ inviterName: 'Ann' })
    expect(hoisted.findInvitation).toHaveBeenCalledTimes(1)
  })

  it('takes only text', () => {
    expect(inputOf(getInviteBrandingFn).safeParse(INVITE).success).toBe(true)
    expect(inputOf(getInviteBrandingFn).safeParse({ id: INVITE }).success).toBe(false)
  })
})

describe('getInvitationDetailsFn', () => {
  const details = getInvitationDetailsFn as unknown as Handler

  it.each(['garbage', 'invite_1', generateId('post')])(
    'answers %j as not found without an invitation query',
    async (id) => {
      await expect(details({ data: id })).rejects.toThrow(NOT_FOUND)
      expect(hoisted.findInvitation).not.toHaveBeenCalled()
    }
  )

  it('looks up a well-formed invite id', async () => {
    hoisted.findInvitation.mockResolvedValue(undefined)
    await expect(details({ data: INVITE })).rejects.toThrow(NOT_FOUND)
    expect(hoisted.findInvitation).toHaveBeenCalledTimes(1)
  })

  it('takes only text', () => {
    expect(inputOf(getInvitationDetailsFn).safeParse(INVITE).success).toBe(true)
    expect(inputOf(getInvitationDetailsFn).safeParse(42).success).toBe(false)
  })
})

describe('invitation write inputs', () => {
  it('acceptInvitationFn takes only an invite id', () => {
    const input = inputOf(acceptInvitationFn)
    expect(input.safeParse({ invitationId: INVITE, name: 'Ann Lee' }).success).toBe(true)
    expect(input.safeParse({ invitationId: 'invite_1' }).success).toBe(false)
    expect(input.safeParse({ invitationId: generateId('post') }).success).toBe(false)
  })

  it('acceptPortalInviteFn takes only an invite id', () => {
    const input = inputOf(acceptPortalInviteFn)
    expect(input.safeParse({ inviteId: INVITE }).success).toBe(true)
    expect(input.safeParse({ inviteId: 'invite_1' }).success).toBe(false)
    expect(input.safeParse({ inviteId: `${INVITE}\u0000` }).success).toBe(false)
  })
})
