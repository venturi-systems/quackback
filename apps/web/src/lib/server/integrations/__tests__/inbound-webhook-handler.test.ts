/**
 * Tests for the status-mapping step of the central inbound webhook handler.
 *
 * The external status name in a webhook payload is external input. A name that
 * a plain object lookup resolves to an Object.prototype member must take the
 * handler's no-mapping path and never reach changeStatus.
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
  postExternalLinks: { integrationType: 'integration_type', externalId: 'external_id' },
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
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
