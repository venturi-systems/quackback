/**
 * Client-safe webhook constants and utilities.
 * Re-exported from the server module so client code can import from here
 * without crossing the server boundary.
 */
export {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_CONFIG,
  isValidWebhookUrl,
} from '@/lib/server/events/integrations/webhook/constants'
export type {
  WebhookEventType,
  WebhookTarget,
  WebhookConfig,
} from '@/lib/server/events/integrations/webhook/constants'
