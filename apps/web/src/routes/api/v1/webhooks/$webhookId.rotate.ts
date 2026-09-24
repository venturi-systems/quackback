import { createFileRoute } from '@tanstack/react-router'
import { recordApiKeyAuditSafely } from '@/lib/server/audit/audit-safe'
import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import { successResponse, handleDomainError } from '@/lib/server/domains/api/responses'
import { parseTypeId } from '@/lib/server/domains/api/validation'
import type { WebhookId } from '@quackback/ids'

export const Route = createFileRoute('/api/v1/webhooks/$webhookId/rotate')({
  server: {
    handlers: {
      /**
       * POST /api/v1/webhooks/:webhookId/rotate
       * Rotate a webhook's signing secret
       */
      POST: async ({ request, params }) => {
        try {
          const auth = await withApiKeyAuth(request, { role: 'admin' })

          const webhookId = parseTypeId<WebhookId>(params.webhookId, 'webhook', 'webhook ID')

          const { rotateWebhookSecret } =
            await import('@/lib/server/domains/webhooks/webhook.service')
          const result = await rotateWebhookSecret(webhookId)
          // Never the secret: the row records that it changed and who did it.
          await recordApiKeyAuditSafely(
            auth,
            { event: 'webhook.secret_rotated', target: { type: 'webhook', id: webhookId } },
            request.headers
          )

          // Return the new secret (only shown once!)
          return successResponse({
            id: result.webhook.id,
            secret: result.secret,
            rotatedAt: new Date().toISOString(),
          })
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
