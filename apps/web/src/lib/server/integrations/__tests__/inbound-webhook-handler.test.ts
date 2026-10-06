/**
 * Tests for the central inbound webhook handler.
 *
 * The external status name in a webhook payload is external input. A name that
 * a plain object lookup resolves to an Object.prototype member must take the
 * handler's no-mapping path and never reach changeStatus.
 *
 * An external ID can be unique only within a container (a GitHub issue number
 * within its repository). When the parsed change carries the item's URL, only
 * the link recorded with that URL may be updated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateId } from '@quackback/ids'

const hoisted = vi.hoisted(() => ({
  integrationFindFirst: vi.fn(),
  linkFindFirst: vi.fn(),
  parseStatusChange: vi.fn(),
  changeStatus: vi.fn(),
  logDebug: vi.fn(),
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      integrations: { findFirst: hoisted.integrationFindFirst },
      postExternalLinks: { findFirst: hoisted.linkFindFirst },
    },
  },
  integrations: { integrationType: 'integration_type', status: 'status' },
  postExternalLinks: {
    integrationType: 'integration_type',
    externalId: 'external_id',
    externalUrl: 'external_url',
  },
  // Inspectable conditions, so a test can evaluate the link lookup's filter
  // against fixture rows instead of asserting on the query's shape.
  eq: vi.fn((column: string, value: unknown) => ({ column, value })),
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
}))

vi.mock('../index', () => ({
  getIntegration: () => ({
    inbound: {
      verifySignature: async () => true,
      parseStatusChange: hoisted.parseStatusChange,
    },
  }),
}))

vi.mock('../encryption', () => ({ decryptSecrets: () => ({}) }))

vi.mock('@/lib/server/domains/posts/post.status', () => ({
  changeStatus: hoisted.changeStatus,
}))

vi.mock('@/lib/server/logger', () => {
  const log = { debug: hoisted.logDebug, info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { logger: { child: () => log } }
})

import { handleInboundWebhook } from '../inbound-webhook-handler'

const DONE = generateId('status')

function integrationRow(statusMappings: Record<string, string | null>) {
  return {
    id: 'integration_test',
    integrationType: 'linear',
    status: 'active',
    principalId: 'principal_test',
    secrets: null,
    config: { webhookSecret: 'whsec_test', statusMappings },
  }
}

function webhookRequest(): Request {
  return new Request('https://feedback.example.com/api/integrations/linear/webhook', {
    method: 'POST',
    body: '{}',
  })
}

function statusChange(externalStatus: string) {
  return { externalId: 'ISSUE-1', externalStatus, eventType: 'Issue.update' }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.integrationFindFirst.mockResolvedValue(integrationRow({ Done: DONE, Backlog: null }))
  hoisted.linkFindFirst.mockResolvedValue({ postId: 'post_test' })
  hoisted.changeStatus.mockResolvedValue(undefined)
})

describe('handleInboundWebhook status mapping', () => {
  it('applies a mapped external status to the linked post', async () => {
    hoisted.parseStatusChange.mockResolvedValue(statusChange('Done'))

    const response = await handleInboundWebhook(webhookRequest(), 'linear')

    expect(response.status).toBe(200)
    expect(hoisted.changeStatus).toHaveBeenCalledTimes(1)
    expect(hoisted.changeStatus).toHaveBeenCalledWith(
      'post_test',
      DONE,
      expect.objectContaining({ principalId: 'principal_test' })
    )
  })

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'Backlog', 'Cancelled'])(
    'takes the no-mapping path for the external status %s',
    async (externalStatus) => {
      hoisted.parseStatusChange.mockResolvedValue(statusChange(externalStatus))

      const response = await handleInboundWebhook(webhookRequest(), 'linear')

      expect(response.status).toBe(200)
      expect(await response.text()).toBe('OK')
      expect(hoisted.changeStatus).not.toHaveBeenCalled()
      expect(hoisted.logDebug).toHaveBeenCalledWith(
        expect.objectContaining({ external_status: externalStatus }),
        'no status mapping, ignoring'
      )
    }
  )
})

type Condition = { column: string; value: unknown }
type LinkRow = Record<string, string | null> & { postId: string }

/** Evaluate the handler's `and(eq(...), ...)` filter against fixture link rows. */
function findLink(rows: LinkRow[]) {
  return async ({ where }: { where: { and: Condition[] } }) =>
    rows.find((row) => where.and.every((c) => row[c.column] === c.value))
}

function githubLink(postId: string, repository: string | null, externalId = '7'): LinkRow {
  return {
    postId,
    integration_type: 'github',
    external_id: externalId,
    external_url: repository ? `https://github.com/${repository}/issues/${externalId}` : null,
  }
}

function githubClosed(repository: string) {
  return {
    externalId: '7',
    externalStatus: 'Closed',
    eventType: 'issues.closed',
    externalUrl: `https://github.com/${repository}/issues/7`,
  }
}

describe('handleInboundWebhook link resolution', () => {
  beforeEach(() => {
    hoisted.integrationFindFirst.mockResolvedValue({
      ...integrationRow({ Closed: DONE, Done: DONE }),
      integrationType: 'github',
    })
    // The first fixture row is the wrong post: a lookup by number alone finds it.
    hoisted.linkFindFirst.mockImplementation(
      findLink([
        githubLink('post_service_a', 'example-org/service-a'),
        githubLink('post_unscoped', null),
        githubLink('post_service_b', 'example-org/service-b'),
      ])
    )
  })

  it('updates only the post linked to the same repository issue', async () => {
    hoisted.parseStatusChange.mockResolvedValue(githubClosed('example-org/service-b'))

    const response = await handleInboundWebhook(webhookRequest(), 'github')

    expect(response.status).toBe(200)
    expect(hoisted.changeStatus).toHaveBeenCalledTimes(1)
    expect(hoisted.changeStatus).toHaveBeenCalledWith('post_service_b', DONE, expect.anything())
  })

  it('updates nothing when no link names the event repository', async () => {
    hoisted.parseStatusChange.mockResolvedValue(githubClosed('example-org/service-c'))

    const response = await handleInboundWebhook(webhookRequest(), 'github')

    expect(response.status).toBe(200)
    expect(hoisted.changeStatus).not.toHaveBeenCalled()
    expect(hoisted.logDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        external_id: '7',
        external_url: 'https://github.com/example-org/service-c/issues/7',
      }),
      'no linked post for external id, ignoring'
    )
  })

  it('keeps ID-only matching for a platform that reports no item URL', async () => {
    hoisted.linkFindFirst.mockImplementation(
      findLink([
        {
          postId: 'post_linear',
          integration_type: 'linear',
          external_id: 'ISSUE-1',
          external_url: null,
        },
      ])
    )
    hoisted.parseStatusChange.mockResolvedValue(statusChange('Done'))

    await handleInboundWebhook(webhookRequest(), 'linear')

    expect(hoisted.changeStatus).toHaveBeenCalledWith('post_linear', DONE, expect.anything())
  })
})
