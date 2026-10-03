import { createHash } from 'node:crypto'
import type { HookTarget } from './hook-types'
import type { EventData } from './types'

/** Stable destination identity excludes expiring credentials/unsubscribe URLs. */
export function durableDestination(hook: HookTarget): string {
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

export function durableTargets(targets: HookTarget[]): HookTarget[] {
  return targets.flatMap((hook) => {
    const target = hook.target as Record<string, unknown>
    if (hook.type !== 'notification') return [hook]
    if (!Array.isArray(target.principalIds)) throw new Error('Invalid notification recipients')
    return [...new Set(target.principalIds.map(String))].map((id) => ({
      ...hook,
      target: { ...target, principalIds: [id] },
    }))
  })
}
export function durableHookJobs(event: EventData, targets: HookTarget[]) {
  return durableTargets(targets).map((hook) => ({
    name: `${event.type}:${hook.type}`,
    // Never persist decrypted credentials or unsubscribe tokens. Resolve the
    // still-authorized destination and its current credentials at delivery.
    data: {
      hookType: hook.type,
      event,
      target: {},
      config: hook.type === 'webhook' ? { webhookId: hook.config.webhookId } : {},
      durableDestination: durableDestination(hook),
    },
    opts: {
      jobId:
        'durable-' +
        event.id +
        '-' +
        createHash('sha256')
          .update(hook.type + '\u0000' + durableDestination(hook))
          .digest('hex'),
      // GC removes terminal jobs only after durable outbox acknowledgment.
      removeOnComplete: false,
      removeOnFail: false,
    },
  }))
}
