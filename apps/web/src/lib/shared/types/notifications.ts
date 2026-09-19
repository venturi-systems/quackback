/**
 * Notification-related types for client use.
 *
 * Re-exported from the server domain for architectural compliance — type-only
 * imports are erased at compile time and never affect the bundle.
 */

export type { NotificationType } from '@/lib/server/domains/notifications/notification.types'
