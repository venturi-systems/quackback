/**
 * DEF-45: `GET /roadmap?board=<anything>` answered HTTP 500 and embedded the
 * raw zod issue ("Invalid input: expected array, received string") in the
 * page, because the route's validateSearch rejected a bare value and the
 * router turns a rejected search into a SearchParamError.
 *
 * These tests drive each route's real validateSearch the way the router does:
 * the query string goes through TanStack's own JSON-first parser, then through
 * the schema's Standard Schema `validate`, which is the call router-core makes.
 * A result carrying `issues` is exactly the case that became a 500. The
 * round-trip check covers the other half: on the server the router redirects
 * to the canonical URL built from the validated values, so that URL must
 * validate to the same values or the redirect would never settle.
 *
 * Passing validation is not enough on its own: a value that validates can
 * still break the query it feeds. Id columns throw on anything that is not a
 * TypeID, integer columns reject out-of-range and fractional numbers, and an
 * invalid Date throws when the query serializes it. The later suites check
 * that such values never come out of validateSearch.
 */
import { describe, expect, it, vi } from 'vitest'
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router'
import { generateId } from '@quackback/ids'

// Route modules are imported for their validateSearch only. Everything they
// pull in for rendering or data loading is stubbed, so no server function,
// query client or heavy component is evaluated here.
vi.mock('@/lib/client/queries/portal', () => ({ portalQueries: {} }))
vi.mock('@/lib/client/queries/admin', () => ({ adminQueries: {} }))
vi.mock('@/lib/client/queries/feedback', () => ({ feedbackQueries: {} }))
vi.mock('@/lib/client/queries/settings', () => ({ settingsQueries: {} }))
vi.mock('@/lib/client/hooks/use-portal-posts-query', () => ({
  votedPostsKeys: { byWorkspace: () => ['votedPosts'] },
}))
vi.mock('@/lib/client/hooks/use-widget-vote', () => ({
  widgetQueryKeys: {},
  INITIAL_SESSION_VERSION: 0,
}))
vi.mock('@/lib/client/widget-auth', () => ({ getWidgetAuthHeaders: () => ({}) }))
vi.mock('@/lib/client/config-file', () => ({ boardAccessManagedPath: () => '' }))
vi.mock('@/lib/server/functions/portal', () => ({ fetchBoardCapabilitiesFn: () => null }))
vi.mock('@/lib/server/functions/subscriptions', () => ({ processUnsubscribeTokenFn: () => null }))
vi.mock('@/components/public/roadmap-board', () => ({ RoadmapBoard: () => null }))
vi.mock('@/components/admin/roadmap-admin', () => ({ RoadmapAdmin: () => null }))
vi.mock('@/components/admin/roadmap-modal', () => ({ RoadmapModal: () => null }))
vi.mock('@/components/admin/tab-strip', () => ({ TabStrip: () => null }))
vi.mock('@/components/admin/users/users-container', () => ({ UsersContainer: () => null }))
vi.mock('@/components/admin/changelog', () => ({
  ChangelogList: () => null,
  ChangelogModal: () => null,
}))
vi.mock('@/components/shared/error-page', () => ({ errorMessage: () => '' }))
vi.mock('@/components/shared/empty-state', () => ({ EmptyState: () => null }))
vi.mock('@/components/shared/page-header', () => ({ PageHeader: () => null }))
vi.mock('@/components/ui/back-link', () => ({ BackLink: () => null }))
vi.mock('@/components/admin/settings/settings-card', () => ({ SettingsCard: () => null }))
vi.mock('@/components/admin/settings/managed-setting-note', () => ({
  useIsManagedSetting: () => false,
}))
vi.mock('@/components/admin/settings/boards/use-board-selection', () => ({
  useBoardSelection: () => ({}),
}))
vi.mock('@/components/admin/settings/boards/create-board-dialog', () => ({
  CreateBoardDialog: () => null,
}))
vi.mock('@/components/admin/settings/boards/board-settings-header', () => ({
  BoardSettingsHeader: () => null,
}))
vi.mock('@/components/admin/settings/boards/board-settings-nav', () => ({
  BoardSettingsNav: () => null,
}))
vi.mock('@/components/admin/settings/boards/board-general-form', () => ({
  BoardGeneralForm: () => null,
}))
vi.mock('@/components/admin/settings/boards/board-access-form', () => ({
  BoardAccessForm: () => null,
}))
vi.mock('@/components/admin/settings/boards/board-moderation-form', () => ({
  BoardModerationForm: () => null,
}))
vi.mock('@/components/admin/settings/boards/board-import-section', () => ({
  BoardImportSection: () => null,
}))
vi.mock('@/components/admin/settings/boards/board-export-section', () => ({
  BoardExportSection: () => null,
}))
vi.mock('@/components/admin/settings/boards/delete-board-form', () => ({
  DeleteBoardForm: () => null,
}))
vi.mock('@/components/admin/settings/api-keys/api-keys-settings', () => ({
  ApiKeysSettings: () => null,
}))
vi.mock('@/components/admin/settings/api-keys/api-usage-guide', () => ({
  ApiUsageGuide: () => null,
}))
vi.mock('@/components/admin/settings/webhooks/webhooks-settings', () => ({
  WebhooksSettings: () => null,
}))
vi.mock('@/components/admin/settings/webhooks/webhook-verification-guide', () => ({
  WebhookVerificationGuide: () => null,
}))
vi.mock('@/components/admin/settings/mcp/mcp-server-settings', () => ({
  McpServerSettings: () => null,
}))
vi.mock('@/components/admin/settings/mcp/mcp-setup-guide', () => ({
  McpSetupGuide: () => null,
}))
vi.mock('@/components/widget/widget-vote-button', () => ({ WidgetVoteButton: () => null }))
vi.mock('@/components/widget/widget-shell', () => ({ WidgetShell: () => null }))
vi.mock('@/components/widget/widget-nav', () => ({
  resolveInitialTab: () => 'feedback',
  resolveInitialView: () => 'feedback',
  supportRootView: () => 'help',
  homeEnabled: () => false,
}))
vi.mock('@/components/widget/widget-home', () => ({ WidgetHome: () => null }))
vi.mock('@/components/widget/widget-overview', () => ({ WidgetOverview: () => null }))
vi.mock('@/components/widget/widget-post-detail', () => ({ WidgetPostDetail: () => null }))
vi.mock('@/components/widget/widget-changelog', () => ({ WidgetChangelog: () => null }))
vi.mock('@/components/widget/widget-changelog-detail', () => ({
  WidgetChangelogDetail: () => null,
}))
vi.mock('@/components/widget/widget-help', () => ({ WidgetHelp: () => null }))
vi.mock('@/components/widget/widget-help-category', () => ({ WidgetHelpCategory: () => null }))
vi.mock('@/components/widget/widget-help-detail', () => ({ WidgetHelpDetail: () => null }))
vi.mock('@/components/widget/widget-live-chat', () => ({ WidgetLiveChat: () => null }))
vi.mock('@/components/widget/widget-messages-section', () => ({
  WidgetMessagesSection: () => null,
}))
vi.mock('@/components/widget/widget-auth-provider', () => ({ useWidgetAuth: () => ({}) }))
vi.mock('@/components/widget/use-chat-presence', () => ({ CHAT_PRESENCE_QUERY_KEY: [] }))
vi.mock('@/components/admin/settings/security/auth-settings', () => ({ AuthSettings: () => null }))

type StandardResult = { value?: Record<string, unknown>; issues?: ReadonlyArray<unknown> }
type StandardSchema = { '~standard': { validate: (input: unknown) => StandardResult } }

function validatorOf(route: unknown): StandardSchema {
  const validator = (route as { options?: { validateSearch?: unknown } }).options?.validateSearch
  if (!validator || typeof validator !== 'object' || !('~standard' in validator)) {
    throw new Error('Route has no Standard Schema validateSearch')
  }
  return validator as StandardSchema
}

/** What the router's validateSearch does with the query string of a request. */
function validate(route: unknown, query: string): StandardResult {
  const result = validatorOf(route)['~standard'].validate(defaultParseSearch(query))
  if (result instanceof Promise) throw new Error('validateSearch must stay synchronous')
  return result
}

/** The validated value of `query`, which must carry no issues. */
function valueOf(route: unknown, query: string): Record<string, unknown> {
  const result = validate(route, query)
  expect(result.issues).toBeUndefined()
  return result.value ?? {}
}

/** A query string in the JSON list form the app's own links write. */
function listQuery(key: string, items: string[]): string {
  return `?${new URLSearchParams({ [key]: JSON.stringify(items) })}`
}

const { Route: portalRoadmap } = await import('../_portal/roadmap.index')
const { Route: portalHome } = await import('../_portal/index')
const { Route: adminFeedback } = await import('../admin/feedback')
const { Route: adminRoadmap } = await import('../admin/roadmap')
const { Route: adminUsers } = await import('../admin/users')
const { Route: adminChangelog } = await import('../admin/changelog')
const { Route: adminHelpCenter } = await import('../admin/help-center')
const { Route: adminBoardSettings } = await import('../admin/settings.boards.index')
const { Route: adminDevelopers } = await import('../admin/settings.developers')
const { Route: widget } = await import('../widget/index')
const { Route: unsubscribe } = await import('../unsubscribe')
// DEF-55: the sign-in, account and OAuth routes.
const { Route: authLogin } = await import('../auth.login')
const { Route: authSignup } = await import('../auth.signup')
const { Route: adminLogin } = await import('../admin.login')
const { Route: oauthConsent } = await import('../oauth/consent')
const { Route: adminAuthSettings } = await import('../admin/settings.security.authentication')

const BOARD = generateId('board')
const OTHER_BOARD = generateId('board')
const TAG = generateId('tag')
const SEGMENT = generateId('segment')
const OTHER_SEGMENT = generateId('segment')
const ROADMAP = generateId('roadmap')
const PRINCIPAL = generateId('principal')
const CATEGORY = generateId('category')
const CONVERSATION = generateId('conversation')

/** Query strings a person can type, paste or follow from another site. */
const HOSTILE_QUERIES = [
  '?board=feature-requests',
  '?board=123',
  '?board=true',
  '?board=',
  '?board=a&board=b',
  '?board=%7B%22a%22%3A1%7D',
  '?board=%5B%5B%22a%22%5D%5D',
  '?board=null',
  '?tags=x&segments=y&status=open&tagIds=t',
  '?search=123',
  '?search=%5B%22a%22%5D',
  '?roadmap=123&post=true&owner=null',
  '?sort=bogus',
  '?sort=123',
  '?minVotes=abc',
  '?minVotes=0',
  '?minVotes=5',
  '?minVotes=99999999999',
  '?minComments=many',
  '?dateFrom=yesterday',
  '?dateFrom=2026-02-31',
  '?dateTo=2026-13-45&updatedBefore=soon',
  '?responded=maybe',
  '?hasDuplicates=yes&deleted=1',
  '?suggestionSort=x&suggestionStatus=y',
  '?owner=foo',
  '?owner=unassigned',
  '?selected=foo&segments=a,b',
  '?postCount=gte:abc&voteCount=bogus:5&commentCount=gte:1.5',
  '?verified=true&includeAnonymous=1&invites=nope',
  '?category=foo&entry=123&status=archived',
  '?tab=bogus',
  '?c=foo',
  '?c=123',
  '?token=123',
  `?board=${BOARD}&tags=${TAG}&segments=${SEGMENT}&roadmap=${ROADMAP}&tagIds=${TAG}`,
  listQuery('board', [BOARD, 'ideas', TAG]),
  `?owner=${PRINCIPAL}&selected=${PRINCIPAL}&segments=${SEGMENT},${OTHER_SEGMENT},x`,
  `?category=${CATEGORY}&c=${CONVERSATION}`,
  '?postCount=gte:5&dateFrom=2026-01-31&dateTo=2026-09-24T10:00:00.000Z',
  '?dateFrom=0000-01-01',
  '?dateFrom=0001-01-01T00:00%2B01:00&dateTo=0000-12-31&updatedBefore=0000-06-01',
  '?search=%00',
  '?board=a%00b',
  '?status=open%00&tags=%00&customAttrs=plan:eq:%00&emailDomain=%00&c=%00&token=%00',
  // DEF-55: `?error=123` reached the sign-in routes as the number 123.
  '?error=123',
  '?callbackUrl=123',
  '?error=123&callbackUrl=123',
  '?error=%5B%22a%22%5D&callbackUrl=%7B%22href%22%3A%22%2Fadmin%22%7D',
  '?error=null&callbackUrl=true',
  '?error=%00&callbackUrl=%2Fadmin%00',
  '?callbackUrl=%2F%2Fevil.example&error=%3Cscript%3E',
  '?tab=team-access',
  '?tab=%5B%22sign-in%22%5D',
  '?client_id=123&state=12345&exp=1700000000&sig=true',
  '?client_id=%5B1%5D&scope=%7B%7D&redirect_uri=null',
]

const ROUTES: Array<[string, unknown]> = [
  ['/_portal/roadmap/', portalRoadmap],
  ['/_portal/', portalHome],
  ['/admin/feedback', adminFeedback],
  ['/admin/roadmap', adminRoadmap],
  ['/admin/users', adminUsers],
  ['/admin/changelog', adminChangelog],
  ['/admin/help-center', adminHelpCenter],
  ['/admin/settings/boards/', adminBoardSettings],
  ['/admin/settings/developers', adminDevelopers],
  ['/widget/', widget],
  ['/unsubscribe', unsubscribe],
  ['/auth/login', authLogin],
  ['/auth/signup', authSignup],
  ['/admin/login', adminLogin],
  ['/oauth/consent', oauthConsent],
  ['/admin/settings/security/authentication', adminAuthSettings],
]

describe.each(ROUTES)('%s validateSearch', (_id, route) => {
  it.each(HOSTILE_QUERIES)('accepts %s without a validation error', (query) => {
    const result = validate(route, query)
    expect(result.issues).toBeUndefined()
  })

  it.each(HOSTILE_QUERIES)('settles the canonical redirect for %s', (query) => {
    const first = validate(route, query).value ?? {}
    const canonical = defaultStringifySearch(first)
    const second = validate(route, canonical).value ?? {}
    expect(second).toEqual(first)
  })
})

describe('DEF-45 normalization', () => {
  it('opens /roadmap?board=<slug> unfiltered, because the filter holds board ids', () => {
    for (const route of [portalRoadmap, adminRoadmap, adminFeedback]) {
      expect(valueOf(route, '?board=feature-requests').board).toBeUndefined()
    }
  })

  it('reads a bare board id as a one-board filter', () => {
    for (const route of [portalRoadmap, adminRoadmap, adminFeedback]) {
      expect(valueOf(route, `?board=${BOARD}`)).toMatchObject({ board: [BOARD] })
    }
  })

  it('keeps the list form the app itself writes', () => {
    expect(valueOf(portalRoadmap, listQuery('board', [BOARD, OTHER_BOARD]))).toMatchObject({
      board: [BOARD, OTHER_BOARD],
    })
  })

  it('reads a malformed choice as the route default', () => {
    expect(valueOf(portalHome, '?sort=bogus')).toMatchObject({ sort: 'trending' })
    expect(valueOf(adminFeedback, '?sort=bogus')).toMatchObject({ sort: 'newest' })
    expect(valueOf(portalRoadmap, '?sort=bogus').sort).toBeUndefined()
  })

  it('reads the portal home status filter from a bare value', () => {
    expect(valueOf(portalHome, '?status=open')).toMatchObject({ status: ['open'] })
  })

  it('keeps a numeric search as the text that was typed', () => {
    expect(valueOf(portalRoadmap, '?search=123')).toMatchObject({ search: '123' })
    expect(valueOf(portalHome, '?search=123')).toMatchObject({ search: '123' })
  })

  it('drops an invalid minimum vote count instead of failing', () => {
    expect(valueOf(portalHome, '?minVotes=abc').minVotes).toBeUndefined()
    expect(valueOf(portalHome, '?minVotes=5')).toMatchObject({ minVotes: 5 })
  })
})

describe('ids the database would reject never leave validateSearch', () => {
  it('keeps only tag ids in the portal home tag filter', () => {
    expect(valueOf(portalHome, '?tagIds=foo').tagIds).toBeUndefined()
    expect(valueOf(portalHome, `?tagIds=${TAG}`)).toMatchObject({ tagIds: [TAG] })
  })

  it('drops malformed and other-entity ids from a list and keeps the rest', () => {
    for (const route of [portalRoadmap, adminRoadmap, adminFeedback]) {
      expect(valueOf(route, listQuery('tags', [TAG, 'ux', BOARD]))).toMatchObject({ tags: [TAG] })
      expect(valueOf(route, listQuery('segments', ['vip', SEGMENT]))).toMatchObject({
        segments: [SEGMENT],
      })
    }
  })

  it('reads a roadmap param that is not a roadmap id as absent', () => {
    for (const route of [portalRoadmap, adminRoadmap]) {
      expect(valueOf(route, '?roadmap=feature').roadmap).toBeUndefined()
      expect(valueOf(route, `?roadmap=${BOARD}`).roadmap).toBeUndefined()
      expect(valueOf(route, `?roadmap=${ROADMAP}`)).toMatchObject({ roadmap: ROADMAP })
    }
  })

  it('keeps the inbox owner filter to "unassigned" or a principal id', () => {
    expect(valueOf(adminFeedback, '?owner=unassigned')).toMatchObject({ owner: 'unassigned' })
    expect(valueOf(adminFeedback, `?owner=${PRINCIPAL}`)).toMatchObject({ owner: PRINCIPAL })
    expect(valueOf(adminFeedback, '?owner=foo').owner).toBeUndefined()
    expect(valueOf(adminFeedback, `?owner=${SEGMENT}`).owner).toBeUndefined()
  })

  it('keeps the users selection and segment filter to their own ids', () => {
    expect(valueOf(adminUsers, `?selected=${PRINCIPAL}`)).toMatchObject({ selected: PRINCIPAL })
    expect(valueOf(adminUsers, '?selected=foo').selected).toBeUndefined()
    expect(valueOf(adminUsers, `?segments=${SEGMENT},vip,${OTHER_SEGMENT}`)).toMatchObject({
      segments: `${SEGMENT},${OTHER_SEGMENT}`,
    })
    expect(valueOf(adminUsers, '?segments=a,b').segments).toBeUndefined()
  })

  it('keeps the help-center category and the widget conversation to their own ids', () => {
    expect(valueOf(adminHelpCenter, `?category=${CATEGORY}`)).toMatchObject({
      category: CATEGORY,
    })
    expect(valueOf(adminHelpCenter, '?category=getting-started').category).toBeUndefined()
    expect(valueOf(widget, `?c=${CONVERSATION}`)).toMatchObject({ c: CONVERSATION })
    expect(valueOf(widget, '?c=foo').c).toBeUndefined()
  })
})

describe('counts and dates the query cannot take read as absent', () => {
  it('keeps inbox thresholds to whole numbers an integer column can hold', () => {
    expect(valueOf(adminFeedback, '?minVotes=5')).toMatchObject({ minVotes: '5' })
    expect(valueOf(adminFeedback, '?minVotes=abc').minVotes).toBeUndefined()
    expect(valueOf(adminFeedback, '?minVotes=99999999999').minVotes).toBeUndefined()
    expect(valueOf(adminFeedback, '?minComments=-1').minComments).toBeUndefined()
    expect(valueOf(portalHome, '?minVotes=99999999999').minVotes).toBeUndefined()
  })

  it('keeps inbox dates to real ISO dates and timestamps', () => {
    expect(valueOf(adminFeedback, '?dateFrom=2026-01-31')).toMatchObject({ dateFrom: '2026-01-31' })
    expect(valueOf(adminFeedback, '?updatedBefore=2026-09-24T10:00:00.000Z')).toMatchObject({
      updatedBefore: '2026-09-24T10:00:00.000Z',
    })
    expect(valueOf(adminFeedback, '?dateFrom=yesterday').dateFrom).toBeUndefined()
    expect(valueOf(adminFeedback, '?dateTo=2026-13-45').dateTo).toBeUndefined()
    expect(valueOf(adminUsers, '?dateFrom=soon').dateFrom).toBeUndefined()
  })

  it('reads a date in UTC year 0, which Postgres rejects, as absent', () => {
    expect(valueOf(portalHome, '?dateFrom=0000-01-01').dateFrom).toBeUndefined()
    expect(valueOf(portalHome, '?dateFrom=0001-01-01')).toMatchObject({ dateFrom: '0001-01-01' })
    for (const route of [adminFeedback, adminUsers]) {
      expect(valueOf(route, '?dateFrom=0000-01-01').dateFrom).toBeUndefined()
      expect(valueOf(route, '?dateTo=0001-01-01T00:00%2B01:00').dateTo).toBeUndefined()
      expect(valueOf(route, '?dateFrom=0001-01-01')).toMatchObject({ dateFrom: '0001-01-01' })
    }
    expect(valueOf(adminFeedback, '?updatedBefore=0000-01-01').updatedBefore).toBeUndefined()
  })

  it('keeps the portal home date to a calendar date, the form its server function takes', () => {
    expect(valueOf(portalHome, '?dateFrom=2026-09-24T10:00:00.000Z').dateFrom).toBeUndefined()
  })

  it('keeps users activity filters to a known operator and a whole number', () => {
    expect(valueOf(adminUsers, '?postCount=gte:5')).toMatchObject({ postCount: 'gte:5' })
    for (const bad of ['gte:abc', 'bogus:5', 'gte:1.5', 'gte:-1', 'gte:5:6', 'gte:', 'gte']) {
      expect(valueOf(adminUsers, `?postCount=${bad}`).postCount).toBeUndefined()
    }
  })
})

describe('a value holding a NUL, which Postgres rejects in text, reads as absent', () => {
  it('drops it from free text, slugs and lists', () => {
    expect(valueOf(portalHome, '?search=%00').search).toBeUndefined()
    expect(valueOf(portalHome, '?board=a%00b').board).toBeUndefined()
    expect(valueOf(portalHome, '?status=open%00').status).toBeUndefined()
    expect(valueOf(portalRoadmap, '?search=a%00').search).toBeUndefined()
    expect(valueOf(adminFeedback, '?search=%00').search).toBeUndefined()
    expect(valueOf(adminUsers, '?customAttrs=plan:eq:%00').customAttrs).toBeUndefined()
    expect(valueOf(adminUsers, '?emailDomain=a%00.example').emailDomain).toBeUndefined()
  })

  it('keeps the same values without the NUL', () => {
    expect(valueOf(portalHome, '?search=a&board=ab')).toMatchObject({ search: 'a', board: 'ab' })
  })
})

// DEF-44: behind the sign-in gate a portal page renders only the gate, yet
// `/roadmap` kept "Roadmap - …", its description and a canonical link in the
// server-rendered head. Child heads now return the gate head first.
describe('gated portal pages take the sign-in head', () => {
  type Head = { meta?: Array<{ title?: string; name?: string; content?: string }>; links?: unknown }

  function headOf(route: unknown) {
    return (route as { options: { head: (ctx: unknown) => Head } }).options.head
  }

  const gated = [
    { routeId: '__root__', status: 'success' },
    { routeId: '/_portal', status: 'success', loaderData: { gate: { workspaceName: 'Venturi' } } },
  ]
  const open = [
    { routeId: '__root__', status: 'success' },
    { routeId: '/_portal', status: 'success', loaderData: { gate: null } },
  ]
  const roadmapData = { workspaceName: 'Venturi', baseUrl: 'https://feedback.example' }

  it('titles /roadmap behind the gate as the sign-in page, with no canonical link', () => {
    const head = headOf(portalRoadmap)({ matches: gated, loaderData: roadmapData })
    expect(head.meta?.[0]).toEqual({ title: 'Sign in · Venturi' })
    expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex, nofollow' })
    expect(head.links).toBeUndefined()
  })

  it('keeps the roadmap title and canonical link when the portal is open', () => {
    const head = headOf(portalRoadmap)({ matches: open, loaderData: roadmapData })
    expect(head.meta?.[0]).toEqual({ title: 'Roadmap - Venturi' })
    expect(head.links).toEqual([{ rel: 'canonical', href: 'https://feedback.example/roadmap' }])
  })

  it('titles the portal home behind the gate as the sign-in page', () => {
    const head = headOf(portalHome)({
      matches: gated,
      loaderData: { accessGated: false, org: { name: 'Venturi' }, baseUrl: '' },
    })
    expect(head.meta?.[0]).toEqual({ title: 'Sign in · Venturi' })
  })
})
