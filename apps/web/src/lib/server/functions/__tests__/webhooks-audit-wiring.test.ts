/**
 * Audit coverage for webhook changes made in the admin UI (landing-page#2309,
 * ledger DEF-80). Each mutation in functions/webhooks.ts writes exactly one
 * audit row with its event, its target and the webhook's fields before and
 * after the change, never its signing secret, and a mutation that fails writes
 * none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  recordAuditSafely: vi.fn(),
  requireAuth: vi.fn(),
  webhooks: {
    listWebhooks: vi.fn(),
    getWebhookById: vi.fn(),
    createWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    rotateWebhookSecret: vi.fn(),
  },
}))

vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    const chain = {
      validator() {
        return chain
      },
      handler(fn: unknown) {
        return fn
      },
    }
    return chain
  },
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({ requireAuth: hoisted.requireAuth }))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))
vi.mock('@/lib/server/audit/audit-safe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/audit/audit-safe')>()),
  recordAuditSafely: hoisted.recordAuditSafely,
}))
vi.mock('@/lib/server/domains/webhooks/webhook.service', () => hoisted.webhooks)

import * as webhookFns from '../webhooks'

type Handler = (args: { data: Record<string, unknown> }) => Promise<unknown>
const call = (fn: unknown, data: Record<string, unknown>) => (fn as Handler)({ data })

function rows() {
  return hoisted.recordAuditSafely.mock.calls.map(([input]) => input as Record<string, unknown>)
}

/** What the real sessionAuditActor makes of the session mocked below. */
const ACTOR = {
  userId: 'user_admin1',
  email: 'admin@example.com',
  role: 'admin',
  type: 'user',
  authMethod: 'session',
}

/** Marks the signing secret, which no audit row may carry. */
const SECRET = 'signing-secret'
const STORED = {
  id: 'webhook_1',
  url: 'https://hooks.example.com/feedback',
  events: ['post.created'],
  boardIds: ['board_1'],
  status: 'active',
  secret: `whsec_stored_${SECRET}`,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
}
const STORED_VIEW = {
  url: 'https://hooks.example.com/feedback',
  events: ['post.created'],
  boardIds: ['board_1'],
  status: 'active',
}
const UPDATED = { ...STORED, url: 'https://hooks.example.com/v2', status: 'disabled' }
const UPDATED_VIEW = { ...STORED_VIEW, url: 'https://hooks.example.com/v2', status: 'disabled' }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({
    user: { id: 'user_admin1', email: 'admin@example.com', name: 'Admin' },
    principal: { id: 'principal_admin1', role: 'admin', type: 'user' },
  })
  hoisted.webhooks.getWebhookById.mockResolvedValue(STORED)
  hoisted.webhooks.createWebhook.mockResolvedValue({
    webhook: STORED,
    secret: `whsec_new_${SECRET}`,
  })
  hoisted.webhooks.updateWebhook.mockResolvedValue(UPDATED)
  hoisted.webhooks.deleteWebhook.mockResolvedValue(undefined)
  hoisted.webhooks.rotateWebhookSecret.mockResolvedValue({ secret: `whsec_rotated_${SECRET}` })
})

describe('webhook changes write exactly one audit row each (DEF-80)', () => {
  it.each([
    {
      name: 'createWebhookFn',
      event: 'webhook.created',
      data: { url: STORED.url, events: ['post.created'], boardIds: ['board_1'] },
      row: { target: { type: 'webhook', id: 'webhook_1' }, after: STORED_VIEW },
    },
    {
      name: 'updateWebhookFn',
      event: 'webhook.updated',
      data: { webhookId: 'webhook_1', url: UPDATED.url, status: 'disabled' },
      row: {
        target: { type: 'webhook', id: 'webhook_1' },
        before: STORED_VIEW,
        after: UPDATED_VIEW,
      },
    },
    {
      name: 'deleteWebhookFn',
      event: 'webhook.deleted',
      data: { webhookId: 'webhook_1' },
      row: { target: { type: 'webhook', id: 'webhook_1' }, before: STORED_VIEW },
    },
    {
      // The row records that the secret changed and who changed it: no values.
      name: 'rotateWebhookSecretFn',
      event: 'webhook.secret_rotated',
      data: { webhookId: 'webhook_1' },
      row: { target: { type: 'webhook', id: 'webhook_1' } },
    },
  ])('$name records one $event row', async ({ name, event, data, row }) => {
    await call(webhookFns[name as keyof typeof webhookFns], data)
    expect(rows()).toEqual([{ event, actor: ACTOR, ...row }])
    expect(hoisted.recordAuditSafely).toHaveBeenCalledWith(expect.anything(), 'request')
    // Never the signing secret, whether stored, new or rotated.
    expect(JSON.stringify(rows())).not.toContain(SECRET)
  })

  it('records a webhook with no event list or board filter as [] and null', async () => {
    hoisted.webhooks.createWebhook.mockResolvedValue({
      webhook: { id: 'webhook_2', url: STORED.url },
      secret: `whsec_new_${SECRET}`,
    })
    await call(webhookFns.createWebhookFn, { url: STORED.url, events: ['post.created'] })
    expect(rows()).toEqual([
      expect.objectContaining({
        target: { type: 'webhook', id: 'webhook_2' },
        after: { url: STORED.url, events: [], boardIds: null, status: null },
      }),
    ])
  })

  it.each([
    {
      name: 'createWebhookFn',
      service: 'createWebhook',
      data: { url: STORED.url, events: ['post.created'] },
    },
    { name: 'updateWebhookFn', service: 'updateWebhook', data: { webhookId: 'webhook_1' } },
    { name: 'deleteWebhookFn', service: 'deleteWebhook', data: { webhookId: 'webhook_1' } },
    {
      name: 'rotateWebhookSecretFn',
      service: 'rotateWebhookSecret',
      data: { webhookId: 'webhook_1' },
    },
  ])('$name records no row when the change itself fails', async ({ name, service, data }) => {
    hoisted.webhooks[service as keyof typeof hoisted.webhooks].mockRejectedValue(
      new Error('write failed')
    )
    await expect(call(webhookFns[name as keyof typeof webhookFns], data)).rejects.toThrow(
      'write failed'
    )
    expect(rows()).toEqual([])
  })

  it('still records an update when the webhook before it cannot be read', async () => {
    hoisted.webhooks.getWebhookById.mockRejectedValue(new Error('read failed'))
    await call(webhookFns.updateWebhookFn, { webhookId: 'webhook_1', status: 'disabled' })
    expect(rows()).toEqual([
      expect.objectContaining({ event: 'webhook.updated', before: null, after: UPDATED_VIEW }),
    ])
  })

  it('checks the administrator role before reading or changing anything', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(
      call(webhookFns.rotateWebhookSecretFn, { webhookId: 'webhook_1' })
    ).rejects.toThrow('Access denied')
    expect(hoisted.requireAuth).toHaveBeenCalledWith({ roles: ['admin'] })
    expect(hoisted.webhooks.getWebhookById).not.toHaveBeenCalled()
    expect(hoisted.webhooks.rotateWebhookSecret).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })
})
