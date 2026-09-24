/**
 * Private-comment recipients (landing-page#2309): a private comment is
 * team-only content, so only subscribers whose stored team role the team
 * identity rule accepts receive it. A stored admin or member on an identity
 * that fails the rule (for example a password-only bootstrap administrator)
 * acts as a contributor, and a service principal never holds a team role.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrincipalId } from '@quackback/ids'

vi.mock('@/lib/server/redis', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  CACHE_KEYS: {
    TENANT_SETTINGS: 'settings:tenant',
    INTEGRATION_MAPPINGS: 'hooks:integration-mappings',
    ACTIVE_WEBHOOKS: 'hooks:webhooks-active',
    SLACK_CHANNELS: 'slack:channels',
  },
}))

const principalFindMany = vi.fn()
// db.select() chains resolve, in call order, to the queued results.
let selectResults: unknown[][] = []
function selectChain(result: unknown[]): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  c.from = () => c
  c.innerJoin = () => c
  c.leftJoin = () => c
  c.where = () => c
  c.limit = async () => result
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return c
}
vi.mock('@/lib/server/db', () => ({
  db: {
    select: () => selectChain(selectResults.shift() ?? []),
    query: { principal: { findMany: (...a: unknown[]) => principalFindMany(...a) } },
  },
  integrations: {},
  integrationEventMappings: {},
  webhooks: {},
  principal: { id: 'principal.id', userId: 'principal.userId', role: 'principal.role' },
  user: { id: 'user.id', email: 'user.email' },
  posts: {},
  boards: {},
  userSegments: {},
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}))

vi.mock('@/lib/server/integrations/encryption', () => ({ decryptSecrets: vi.fn() }))
vi.mock('@/lib/server/domains/webhooks/encryption', () => ({ decryptWebhookSecret: vi.fn() }))
vi.mock('@/lib/server/domains/subscriptions/subscription.service', () => ({
  getSubscribersForEvent: vi.fn(),
  batchGetNotificationPreferences: vi.fn(),
  batchGenerateUnsubscribeTokens: vi.fn(),
}))
vi.mock('@/lib/server/domains/ai/config', () => ({ getOpenAI: vi.fn().mockReturnValue(null) }))
vi.mock('../hook-context', () => ({ buildHookContext: vi.fn() }))

// The rule itself is covered in team-identity.test.ts; here it accepts exactly
// the principal ids the test lists.
let accepted = new Set<string>()
const principalsActingAsTeam = vi.fn(async (rows: Array<{ id: string }>) =>
  rows.filter((r) => accepted.has(r.id))
)
const resolveTeamRole = vi.fn(async (row: { id: string; role: string | null }) =>
  (row.role === 'admin' || row.role === 'member') && accepted.has(row.id) ? row.role : 'user'
)
vi.mock('@/lib/server/domains/principals/team-identity', () => ({
  principalsActingAsTeam: (rows: Array<{ id: string }>) => principalsActingAsTeam(rows),
  resolveTeamRole: (row: { id: string; role: string | null }) => resolveTeamRole(row),
}))

const { filterToTeamMembers, filterSubscribersByPostAudience } = await import('../targets')

const subscriber = (principalId: string) => ({
  principalId: principalId as PrincipalId,
  userId: `user_${principalId}`,
  email: `${principalId}@example.com`,
  name: principalId,
  reason: 'author' as const,
  notifyComments: true,
  notifyStatusChanges: true,
})

beforeEach(() => {
  vi.clearAllMocks()
  accepted = new Set()
  selectResults = []
})

describe('filterToTeamMembers', () => {
  it('keeps only subscribers the team identity rule accepts as team', async () => {
    principalFindMany.mockResolvedValue([
      { id: 'principal_admin', role: 'admin', type: 'user', userId: 'user_a' },
      { id: 'principal_bootstrap', role: 'admin', type: 'user', userId: 'user_b' },
      { id: 'principal_contributor', role: 'user', type: 'user', userId: 'user_c' },
    ])
    accepted = new Set(['principal_admin'])

    const kept = await filterToTeamMembers([
      subscriber('principal_admin'),
      subscriber('principal_bootstrap'),
      subscriber('principal_contributor'),
    ])

    expect(kept.map((s) => s.principalId)).toEqual(['principal_admin'])
    // The rule sees every stored row, with the columns it needs.
    expect(principalsActingAsTeam).toHaveBeenCalledWith([
      { id: 'principal_admin', role: 'admin', type: 'user', userId: 'user_a' },
      { id: 'principal_bootstrap', role: 'admin', type: 'user', userId: 'user_b' },
      { id: 'principal_contributor', role: 'user', type: 'user', userId: 'user_c' },
    ])
    expect(principalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { id: true, role: true, type: true, userId: true },
      })
    )
  })

  it('returns nothing without querying when there are no subscribers', async () => {
    expect(await filterToTeamMembers([])).toEqual([])
    expect(principalFindMany).not.toHaveBeenCalled()
  })
})

describe('filterSubscribersByPostAudience (a post only the team may see yet)', () => {
  const anyoneMayView = {
    view: 'anonymous',
    vote: 'anonymous',
    comment: 'anonymous',
    submit: 'anonymous',
    segments: { view: [], vote: [], comment: [], submit: [] },
    moderation: { anonPosts: 'inherit', signedPosts: 'inherit', comments: 'inherit' },
  }

  it('keeps the accepted team member and drops a stored team role the rule rejects', async () => {
    selectResults = [
      // The post: pending moderation, so only the team (and its author) may see it.
      [{ moderationState: 'pending', principalId: 'principal_author', access: anyoneMayView }],
      // The subscribers' principals.
      [
        { id: 'principal_admin', role: 'admin', type: 'user', userId: 'user_a' },
        { id: 'principal_bootstrap', role: 'admin', type: 'user', userId: 'user_b' },
        { id: 'principal_contributor', role: 'user', type: 'user', userId: 'user_c' },
      ],
      // Their segment memberships.
      [],
    ]
    accepted = new Set(['principal_admin'])

    const kept = await filterSubscribersByPostAudience('post_1' as never, [
      subscriber('principal_admin'),
      subscriber('principal_bootstrap'),
      subscriber('principal_contributor'),
    ])

    expect(kept.map((s) => s.principalId)).toEqual(['principal_admin'])
    expect(resolveTeamRole).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'principal_bootstrap', role: 'admin', userId: 'user_b' })
    )
  })
})
