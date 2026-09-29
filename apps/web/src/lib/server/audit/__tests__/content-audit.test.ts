/**
 * The shared audit rows for tags, roadmaps and changelog entries
 * (landing-page#2309, extras report section 1): what each view records, when
 * a changelog change also counts as publishing, and who each caller is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ recordAuditSafely: vi.fn() }))

vi.mock('../audit-safe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit-safe')>()),
  recordAuditSafely: hoisted.recordAuditSafely,
}))

import {
  apiKeyAuditSource,
  auditSnapshot,
  changelogAuditView,
  mcpAuditSource,
  recordChangelogChange,
  recordContentAudit,
  roadmapAuditView,
  sessionAuditSource,
  tagAuditView,
} from '../content-audit'

beforeEach(() => {
  vi.clearAllMocks()
})

const session = sessionAuditSource({
  user: { id: 'user_1', email: 'admin@example.com' },
  principal: { role: 'admin', type: 'user' },
})

function events() {
  return hoisted.recordAuditSafely.mock.calls.map(([input]) => (input as { event: string }).event)
}

describe('audit views', () => {
  it('record a tag, a roadmap and a changelog entry without their bodies', () => {
    expect(tagAuditView({ name: 'Bug', color: '#ef4444' })).toEqual({
      name: 'Bug',
      color: '#ef4444',
      description: null,
    })
    expect(
      roadmapAuditView({ name: 'Q1', slug: 'q1', isPublic: true, description: 'Plan' })
    ).toEqual({ name: 'Q1', slug: 'q1', description: 'Plan', isPublic: true })
    const entry = {
      title: 'v2',
      content: 'a long body the audit row must not carry',
      publishedAt: new Date('2026-09-01T00:00:00.000Z'),
      displayDate: null,
    }
    expect(changelogAuditView(entry)).toEqual({
      title: 'v2',
      publishedAt: '2026-09-01T00:00:00.000Z',
      displayDate: null,
    })
  })

  it('reads a before-value as null when it cannot be read', async () => {
    await expect(auditSnapshot(async () => ({ a: 1 }))).resolves.toEqual({ a: 1 })
    await expect(
      auditSnapshot(async () => {
        throw new Error('gone')
      })
    ).resolves.toBeNull()
  })
})

describe('changelog publish rows', () => {
  const draft = { title: 'v2', publishedAt: null, displayDate: null }
  const published = { title: 'v2', publishedAt: '2026-09-01T00:00:00.000Z', displayDate: null }

  it('records only the change for a draft', async () => {
    await recordChangelogChange(session, 'changelog.created', 'changelog_1', null, draft)
    expect(events()).toEqual(['changelog.created'])
  })

  it('also records changelog.published when an entry is created published', async () => {
    await recordChangelogChange(session, 'changelog.created', 'changelog_1', null, published)
    expect(events()).toEqual(['changelog.created', 'changelog.published'])
  })

  it('also records changelog.published when an update publishes a draft', async () => {
    await recordChangelogChange(session, 'changelog.updated', 'changelog_1', draft, published)
    expect(events()).toEqual(['changelog.updated', 'changelog.published'])
  })

  it('does not record a second publish for an entry that was already published', async () => {
    await recordChangelogChange(session, 'changelog.updated', 'changelog_1', published, {
      ...published,
      title: 'v2.1',
    })
    expect(events()).toEqual(['changelog.updated'])
  })

  it('writes the target, before and after on every row', async () => {
    await recordChangelogChange(session, 'changelog.updated', 'changelog_1', draft, published)
    for (const [input, headers] of hoisted.recordAuditSafely.mock.calls) {
      expect(input).toMatchObject({
        target: { type: 'changelog', id: 'changelog_1' },
        before: draft,
        after: published,
        actor: { userId: 'user_1', role: 'admin', authMethod: 'session' },
      })
      expect(headers).toBe('request')
    }
  })
})

describe('audit sources', () => {
  it('names an API key caller and passes its request headers', async () => {
    const headers = new Headers({ 'user-agent': 'client' })
    const source = apiKeyAuditSource(
      { principalId: 'principal_k', role: 'team', apiKey: { id: 'key_1', name: 'CI' } },
      headers
    )
    await recordContentAudit(source, { event: 'tag.created', target: { type: 'tag', id: 't' } })
    const [input, passed] = hoisted.recordAuditSafely.mock.calls[0]
    expect(input).toMatchObject({
      event: 'tag.created',
      actor: { type: 'api_key', authMethod: 'api_key', role: 'team' },
      metadata: { apiKeyId: 'key_1', apiKeyName: 'CI', principalId: 'principal_k' },
    })
    expect(passed).toBe(headers)
  })

  it('names an MCP caller: an OAuth token as its user, an API key as a service key', () => {
    const oauth = mcpAuditSource({
      principalId: 'principal_u' as never,
      userId: 'user_u' as never,
      name: 'Ada',
      email: 'ada@example.com',
      role: 'member',
      authMethod: 'oauth',
      scopes: [],
    })
    expect(oauth.actor).toEqual({
      userId: 'user_u',
      email: 'ada@example.com',
      role: 'member',
      type: 'user',
      authMethod: null,
    })
    expect(oauth.metadata).toEqual({
      via: 'mcp',
      mcpAuthMethod: 'oauth',
      principalId: 'principal_u',
    })
    const key = mcpAuditSource({
      principalId: 'principal_k' as never,
      name: 'Service',
      role: 'admin',
      authMethod: 'api-key',
      scopes: [],
    })
    expect(key.actor).toMatchObject({ userId: null, type: 'api_key', authMethod: 'api_key' })
  })
})
