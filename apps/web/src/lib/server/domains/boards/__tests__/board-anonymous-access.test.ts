/**
 * DEF-42 (landing-page#2309, feedback#237): the deployment's policy may own
 * the "Anyone" (anonymous) tier on boards (POLICY_MANAGED_SETTINGS
 * `boards.anonymousAccess`).
 *
 * Venturi's feedback reconciler holds every board outside its allowlist to
 * signed-in tiers with a database trigger. Before this rule the app did not
 * know it: a board created with an anonymous tier was saved and silently
 * rewritten by the trigger, and an update to an anonymous tier failed with the
 * trigger's raw exception (a server error). Now the app refuses a chosen
 * anonymous tier with a clean 403 FIELD_MANAGED before any write, and a board
 * whose caller chose no access starts at the signed-in tier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  tierLimitsRead: 0,
}))

vi.mock('@/lib/server/db', async () => {
  const drizzle = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')
  return {
    db: {
      query: {
        // No slug collision: every probe for an existing board finds nothing.
        boards: { findFirst: async () => undefined },
      },
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          hoisted.inserted.push(row)
          return { returning: async () => [{ id: 'board_new', ...row }] }
        },
      }),
    },
    boards: { id: 'id', slug: 'slug', deletedAt: 'deletedAt' },
    posts: { boardId: 'boardId', deletedAt: 'deletedAt' },
    webhooks: { boardIds: 'boardIds' },
    eq: drizzle.eq,
    and: drizzle.and,
    isNull: drizzle.isNull,
    inArray: drizzle.inArray,
    asc: drizzle.asc,
    sql: drizzle.sql,
  }
})
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: vi.fn(async () => {
    hoisted.tierLimitsRead += 1
    return { maxBoards: null }
  }),
}))
vi.mock('@/lib/server/domains/settings/tier-enforce', () => ({ enforceCountLimit: vi.fn() }))

const { createBoard } = await import('../board.service')
const {
  anonymousTierActions,
  assertBoardAccessWithinPolicy,
  defaultAccessWithinPolicy,
  isBoardAnonymousAccessPolicyManaged,
} = await import('../board-access-policy')
const { accessForPreset, boardAccessSchema } = await import('@/lib/shared/schemas/boards')
const { DEFAULT_BOARD_ACCESS } = await import('@/lib/shared/db-types')
const { BOARD_ANONYMOUS_ACCESS_PATH, isPolicyManagedPathOption } = await import(
  '@/lib/shared/policy-managed-paths'
)
const { parsePolicyManagedSettings } = await import('@/lib/server/config')
const { handleDomainError } = await import('@/lib/server/domains/api/responses')
const { ForbiddenError } = await import('@/lib/shared/errors')

const SIGNED_IN_DEFAULT = {
  view: 'authenticated',
  vote: 'authenticated',
  comment: 'authenticated',
  submit: 'authenticated',
  segments: { view: [], vote: [], comment: [], submit: [] },
  moderation: { anonPosts: 'inherit', signedPosts: 'inherit', comments: 'inherit' },
}

const saved = process.env.POLICY_MANAGED_SETTINGS

function declare(value: string | undefined) {
  if (value === undefined) delete process.env.POLICY_MANAGED_SETTINGS
  else process.env.POLICY_MANAGED_SETTINGS = value
}

beforeEach(() => {
  hoisted.inserted = []
  hoisted.tierLimitsRead = 0
  // The Venturi gated posture's list plus the new rule.
  declare('portal.access.visibility,auth.oauth,boards.anonymousAccess')
})

afterEach(() => {
  declare(saved)
})

describe('boards.anonymousAccess is a lockable path', () => {
  it('is a policy-managed path option the environment parser keeps', () => {
    expect(BOARD_ANONYMOUS_ACCESS_PATH).toBe('boards.anonymousAccess')
    expect(isPolicyManagedPathOption(BOARD_ANONYMOUS_ACCESS_PATH)).toBe(true)
    expect(parsePolicyManagedSettings('boards.anonymousAccess,portal.oauth')).toEqual([
      'boards.anonymousAccess',
      'portal.oauth',
    ])
  })

  it('is read from the environment at call time', () => {
    expect(isBoardAnonymousAccessPolicyManaged()).toBe(true)
    declare('portal.access.visibility,boards.feature-requests.access')
    expect(isBoardAnonymousAccessPolicyManaged()).toBe(false)
    declare(undefined)
    expect(isBoardAnonymousAccessPolicyManaged()).toBe(false)
  })
})

describe('createBoard under the anonymous-tier policy', () => {
  it('refuses a chosen anonymous tier with a clean 403 FIELD_MANAGED before any write', async () => {
    const error = await createBoard({ name: 'Ideas', access: accessForPreset('public') }).catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({
      code: 'FIELD_MANAGED',
      statusCode: 403,
      message: expect.stringContaining('(requested for view)'),
    })
    // The published boards may keep Anyone in the public posture, so the
    // message names the boards the rule covers instead of every board.
    expect((error as Error).message).toContain('requires sign-in on every board it does not manage')
    expect(hoisted.inserted).toEqual([])
    // Refused before the tier-limit count query as well.
    expect(hoisted.tierLimitsRead).toBe(0)
  })

  it('answers the REST API with 403, not a server error', async () => {
    const error = await createBoard({ name: 'Ideas', access: DEFAULT_BOARD_ACCESS }).catch(
      (e: unknown) => e
    )
    const response = handleDomainError(error)
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('boards.anonymousAccess')
    expect(body.error.message).toContain('view, vote, comment, submit')
  })

  it('starts a board whose caller chose no access at the signed-in tier', async () => {
    const board = await createBoard({ name: 'API Board' })
    expect(hoisted.inserted).toHaveLength(1)
    expect(hoisted.inserted[0]!.access).toEqual(SIGNED_IN_DEFAULT)
    expect(board.access).toEqual(SIGNED_IN_DEFAULT)
  })

  it('keeps a chosen access that uses no anonymous tier', async () => {
    await createBoard({ name: 'Internal', access: accessForPreset('private') })
    expect(hoisted.inserted[0]!.access).toEqual(accessForPreset('private'))
  })

  it('changes nothing when the policy does not own the tier', async () => {
    declare('portal.access.visibility,auth.oauth')
    await createBoard({ name: 'Open Board' })
    await createBoard({ name: 'Public Board', access: accessForPreset('public') })
    // The column default applies, exactly as before.
    expect(hoisted.inserted[0]).not.toHaveProperty('access')
    expect(hoisted.inserted[1]!.access).toEqual(accessForPreset('public'))
  })
})

describe('board-access-policy helpers', () => {
  it('lists the actions a matrix opens to anyone, in display order', () => {
    expect(anonymousTierActions(DEFAULT_BOARD_ACCESS)).toEqual([
      'view',
      'vote',
      'comment',
      'submit',
    ])
    expect(anonymousTierActions(accessForPreset('public'))).toEqual(['view'])
    expect(anonymousTierActions(accessForPreset('private'))).toEqual([])
  })

  it('lets a matrix without the anonymous tier through', () => {
    expect(() => assertBoardAccessWithinPolicy(SIGNED_IN_DEFAULT as never)).not.toThrow()
    expect(() => assertBoardAccessWithinPolicy(accessForPreset('private'))).not.toThrow()
  })

  it('raises only anonymous tiers and keeps a default the schema accepts', () => {
    const lowered = defaultAccessWithinPolicy(accessForPreset('public'))
    expect(lowered).toEqual({ ...accessForPreset('public'), view: 'authenticated' })
    expect(boardAccessSchema.safeParse(lowered).success).toBe(true)
    expect(boardAccessSchema.safeParse(defaultAccessWithinPolicy()).success).toBe(true)
    // The input is never mutated.
    expect(accessForPreset('public').view).toBe('anonymous')
    expect(DEFAULT_BOARD_ACCESS.view).toBe('anonymous')
  })

  it('returns the given default unchanged when the policy does not own the tier', () => {
    declare(undefined)
    expect(defaultAccessWithinPolicy()).toBe(DEFAULT_BOARD_ACCESS)
    expect(() => assertBoardAccessWithinPolicy(DEFAULT_BOARD_ACCESS)).not.toThrow()
  })
})
