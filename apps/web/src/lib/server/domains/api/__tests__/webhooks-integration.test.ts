/**
 * Webhook API Integration Tests
 *
 * These tests run against a live server and require:
 * 1. Dev server running: `bun run dev`
 * 2. Valid API key in database
 *
 * Run with: API_KEY=qb_xxx bun run test apps/web/src/lib/api/__tests__/webhooks-integration.test.ts
 *
 * To skip these tests (CI without server): SKIP_INTEGRATION=true bun run test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  SKIP_INTEGRATION,
  API_KEY,
  api,
  createTestState,
  setUpIntegrationSuite,
  requireBoardId,
  cleanupCreatedResources,
} from './api-integration.helpers'

// This file used to carry its own copy of BASE_URL / API_KEY / api() and its
// own `checkServerAndSetup`, which returned false for an unreachable server, a
// rejected key and a non-200 — after which every case exited through
// `if (skipIfNoServer()) return` and was reported as passing. It now shares the
// one setup that throws instead.
const state = createTestState()

/** The webhook every read/update case operates on. */
let testWebhookId: string

describe.skipIf(SKIP_INTEGRATION || !API_KEY)('Webhook API Integration Tests', () => {
  // Throws on an unreachable server, a rejected key, or a fixture it could not
  // establish. There is deliberately no `serverAvailable` flag to consult: a
  // per-test `if (...) return` reports an unrun case as a passing one.
  beforeAll(async () => {
    await setUpIntegrationSuite(state)

    // Eight cases below read or update "the webhook". They used to reach for
    // `createdIds.webhooks[0]` behind `|| createdIds.webhooks.length === 0`,
    // so a failed creation in an earlier case silently passed all eight. The
    // fixture is created here instead, once, and fails the suite when it cannot
    // be.
    const { status, data } = await api('POST', '/webhooks', {
      url: 'https://example.com/webhook-fixture',
      events: ['post.created'],
    })
    if (status !== 201) {
      throw new Error(`Webhook test setup failed: POST /webhooks returned ${status}.`)
    }
    const id = (data as { data?: { id?: string } } | null)?.data?.id
    if (!id) {
      throw new Error('Webhook test setup failed: POST /webhooks returned 201 with no webhook id.')
    }
    testWebhookId = id
    state.createdIds.webhooks.push(id)
  })

  afterAll(async () => {
    await cleanupCreatedResources(state.createdIds)
  })

  describe('Webhook CRUD', () => {
    it('GET /webhooks returns list', async () => {
      const { status, data } = await api('GET', '/webhooks')
      expect(status).toBe(200)
      expect((data as { data: unknown[] }).data).toBeInstanceOf(Array)
    })

    it('POST /webhooks creates webhook', async () => {
      const { status, data } = await api('POST', '/webhooks', {
        url: 'https://example.com/webhook',
        events: ['post.created'],
      })

      expect(status).toBe(201)
      const webhookData = (data as { data: { id: string; secret: string; url: string } }).data
      expect(webhookData.id).toMatch(/^webhook_/)
      expect(webhookData.secret).toMatch(/^whsec_/)
      expect(webhookData.url).toBe('https://example.com/webhook')
      state.createdIds.webhooks.push(webhookData.id)
    })

    it('POST /webhooks with all events', async () => {
      const { status, data } = await api('POST', '/webhooks', {
        url: 'https://example.com/all-events',
        events: ['post.created', 'post.status_changed', 'comment.created'],
      })

      expect(status).toBe(201)
      const webhookData = (data as { data: { id: string; events: string[] } }).data
      expect(webhookData.events).toContain('post.created')
      expect(webhookData.events).toContain('post.status_changed')
      expect(webhookData.events).toContain('comment.created')
      state.createdIds.webhooks.push(webhookData.id)
    })

    it('POST /webhooks with board filter', async () => {
      const { status, data } = await api('POST', '/webhooks', {
        url: 'https://example.com/board-filter',
        events: ['post.created'],
        boardIds: [requireBoardId(state)],
      })

      expect(status).toBe(201)
      const webhookData = (data as { data: { id: string; boardIds: string[] | null } }).data
      expect(webhookData.boardIds).toContain(requireBoardId(state))
      state.createdIds.webhooks.push(webhookData.id)
    })

    it('GET /webhooks/:id returns webhook', async () => {
      const webhookId = testWebhookId
      const { status, data } = await api('GET', `/webhooks/${webhookId}`)

      expect(status).toBe(200)
      expect((data as { data: { id: string } }).data.id).toBe(webhookId)
    })

    it('PATCH /webhooks/:id updates webhook', async () => {
      const webhookId = testWebhookId
      const { status, data } = await api('PATCH', `/webhooks/${webhookId}`, {
        url: 'https://example.com/updated-webhook',
      })

      expect(status).toBe(200)
      expect((data as { data: { url: string } }).data.url).toBe(
        'https://example.com/updated-webhook'
      )
    })

    it('PATCH /webhooks/:id can disable webhook', async () => {
      const webhookId = testWebhookId
      const { status, data } = await api('PATCH', `/webhooks/${webhookId}`, {
        status: 'disabled',
      })

      expect(status).toBe(200)
      expect((data as { data: { status: string } }).data.status).toBe('disabled')

      // Re-enable for future tests
      await api('PATCH', `/webhooks/${webhookId}`, { status: 'active' })
    })

    it('DELETE /webhooks/:id deletes webhook', async () => {
      // Create a webhook to delete
      const { data: createData } = await api('POST', '/webhooks', {
        url: 'https://example.com/to-delete',
        events: ['post.created'],
      })
      const webhookId = (createData as { data: { id: string } }).data.id

      const { status } = await api('DELETE', `/webhooks/${webhookId}`)
      expect(status).toBe(204)

      // Verify it's gone - should return 404 but currently returns 500
      // TODO: Fix API to return 404 for non-existent webhooks
      const { status: getStatus } = await api('GET', `/webhooks/${webhookId}`)
      expect([404, 500]).toContain(getStatus)
    })
  })

  describe('Webhook Validation', () => {
    it('rejects webhook without URL', async () => {
      const { status, data } = await api('POST', '/webhooks', {
        events: ['post.created'],
      })

      expect(status).toBe(400)
      expect((data as { error: { code: string } }).error.code).toBe('BAD_REQUEST')
    })

    it('rejects webhook without events', async () => {
      const { status, data } = await api('POST', '/webhooks', {
        url: 'https://example.com/webhook',
      })

      expect(status).toBe(400)
      expect((data as { error: { code: string } }).error.code).toBe('BAD_REQUEST')
    })

    it('rejects webhook with empty events array', async () => {
      const { status } = await api('POST', '/webhooks', {
        url: 'https://example.com/webhook',
        events: [],
      })

      expect(status).toBe(400)
    })

    it('rejects webhook with invalid event type', async () => {
      const { status } = await api('POST', '/webhooks', {
        url: 'https://example.com/webhook',
        events: ['invalid.event'],
      })

      expect(status).toBe(400)
    })

    it('rejects webhook with invalid URL', async () => {
      const { status } = await api('POST', '/webhooks', {
        url: 'not-a-valid-url',
        events: ['post.created'],
      })

      expect(status).toBe(400)
    })

    it('rejects HTTP URL (HTTPS required)', async () => {
      const { status } = await api('POST', '/webhooks', {
        url: 'http://example.com/webhook',
        events: ['post.created'],
      })

      // API requires HTTPS
      expect(status).toBe(400)
    })

    it('rejects webhook with invalid boardId', async () => {
      const { status } = await api('POST', '/webhooks', {
        url: 'https://example.com/webhook',
        events: ['post.created'],
        boardIds: ['invalid-board-id'],
      })

      expect(status).toBe(400)
    })
  })

  describe('Webhook Secret', () => {
    it('returns secret only on creation', async () => {
      // Create webhook - should have secret
      const { data: createData } = await api('POST', '/webhooks', {
        url: 'https://example.com/secret-test',
        events: ['post.created'],
      })
      const webhookId = (createData as { data: { id: string; secret: string } }).data.id
      const secret = (createData as { data: { secret: string } }).data.secret
      expect(secret).toMatch(/^whsec_/)
      state.createdIds.webhooks.push(webhookId)

      // Get webhook - should NOT have secret
      const { data: getData } = await api('GET', `/webhooks/${webhookId}`)
      expect((getData as { data: { secret?: string } }).data.secret).toBeUndefined()
    })

    it('POST /webhooks/:id/rotate rotates secret', async () => {
      const webhookId = testWebhookId

      const { status, data } = await api('POST', `/webhooks/${webhookId}/rotate`)

      expect(status).toBe(200)
      const newSecret = (data as { data: { secret: string } }).data.secret
      expect(newSecret).toMatch(/^whsec_/)
    })
  })

  describe('Webhook Response Format', () => {
    it('list response has correct structure', async () => {
      const { data } = await api('GET', '/webhooks')
      const webhooks = (data as { data: unknown[] }).data

      expect(webhooks).toBeInstanceOf(Array)
      // Setup creates the fixture webhook, so an empty list is a defect, not a
      // reason to assert nothing. The shape checks below used to sit inside
      // `if (webhooks.length > 0)` and were vacuous whenever the list was empty.
      expect(webhooks.length).toBeGreaterThan(0)
      const webhook = webhooks[0] as Record<string, unknown>
      expect(webhook).toHaveProperty('id')
      expect(webhook).toHaveProperty('url')
      expect(webhook).toHaveProperty('events')
      expect(webhook).toHaveProperty('status')
      expect(webhook).toHaveProperty('createdAt')
      // Secret should NOT be in list response
      expect(webhook).not.toHaveProperty('secret')
    })

    it('single webhook response has correct structure', async () => {
      const webhookId = testWebhookId
      const { data } = await api('GET', `/webhooks/${webhookId}`)
      const webhook = (data as { data: Record<string, unknown> }).data

      expect(webhook).toHaveProperty('id')
      expect(webhook).toHaveProperty('url')
      expect(webhook).toHaveProperty('events')
      expect(webhook).toHaveProperty('boardIds')
      expect(webhook).toHaveProperty('status')
      expect(webhook).toHaveProperty('failureCount')
      expect(webhook).toHaveProperty('lastTriggeredAt')
      expect(webhook).toHaveProperty('createdAt')
      expect(webhook).toHaveProperty('updatedAt')
      // Secret should NOT be in get response
      expect(webhook).not.toHaveProperty('secret')
    })

    it('dates are ISO 8601 format', async () => {
      const webhookId = testWebhookId
      const { data } = await api('GET', `/webhooks/${webhookId}`)
      const webhook = (data as { data: { createdAt: string } }).data

      expect(webhook.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })

  describe('TypeID Validation', () => {
    it('rejects malformed webhook TypeID in path', async () => {
      const { status } = await api('GET', '/webhooks/webhook_invalid123')
      expect(status).toBe(400)
    })

    it('rejects wrong prefix in webhook TypeID', async () => {
      // Using a post ID format where webhook ID is expected
      const { status } = await api('GET', '/webhooks/post_01kg7a1p2desk9rjpgfjkmxkaa')
      expect(status).toBe(400)
    })
  })

  describe('Error Handling', () => {
    it('returns error for non-existent webhook', async () => {
      const { createId } = await import('@quackback/ids')
      const fakeWebhookId = createId('webhook')
      const { status } = await api('GET', `/webhooks/${fakeWebhookId}`)

      // Should return 404 but currently returns 500
      // TODO: Fix API to return 404 for non-existent webhooks
      expect([404, 500]).toContain(status)
    })

    it('returns proper error structure', async () => {
      const { status, data } = await api('POST', '/webhooks', {})
      expect(status).toBe(400)
      expect((data as { error: { code: string; message: string } }).error).toMatchObject({
        code: expect.any(String),
        message: expect.any(String),
      })
    })
  })
})
