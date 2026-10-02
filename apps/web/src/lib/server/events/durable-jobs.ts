import { createHash } from 'node:crypto'
import type { HookTarget } from './hook-types'
import type { EventData } from './types'

/** Stable destination identity excludes expiring credentials/unsubscribe URLs. */
function destination(hook: HookTarget): string {
  const target = hook.target as Record<string, unknown>
  if (hook.type === 'email' && typeof target.email === 'string') return target.email
  if (
    hook.type === 'notification' &&
    Array.isArray(target.principalIds) &&
    target.principalIds.length === 1
  ) {
    return String(target.principalIds[0])
  }
  if (hook.type === 'webhook' && typeof hook.config.webhookId === 'string')
    return hook.config.webhookId
  if (typeof target.channelId === 'string') return target.channelId
  throw new Error('Durable event target has no stable destination identity')
}

export function durableHookJobs(event: EventData, targets: HookTarget[]) {
  // Native notifications batch recipients. Split only this opt-in path so
  // changing subscriber order/membership cannot alter an existing job identity.
  const recipients = targets.flatMap((hook) => {
    const target = hook.target as Record<string, unknown>
    if (hook.type !== 'notification') return [hook]
    if (!Array.isArray(target.principalIds)) throw new Error('Invalid notification recipients')
    return [...new Set(target.principalIds.map(String))].map((id) => ({
      ...hook,
      target: { ...target, principalIds: [id] },
    }))
  })
  return recipients.map((hook) => ({
    name: `${event.type}:${hook.type}`,
    data: { hookType: hook.type, event, target: hook.target, config: hook.config },
    opts: {
      jobId:
        'durable-' +
        event.id +
        '-' +
        createHash('sha256')
          .update(hook.type + '\u0000' + destination(hook))
          .digest('hex'),
      // Admission acknowledgments may be retried after arbitrarily long
      // outages. Retain these IDs until an explicit acknowledged-event GC.
      removeOnComplete: false,
      removeOnFail: false,
    },
  }))
}
