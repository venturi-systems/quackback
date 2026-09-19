/**
 * CLI: drop the magic-link sign-in rate-limit buckets so repeated e2e runs on
 * the same email addresses don't trip the limiter.
 *
 * `checkMagicLinkSendRateLimit` (src/lib/server/auth/signin-rate-limit.ts)
 * allows 3 sends per 15 minutes per (ip, email) and 20 per 15 minutes per ip,
 * under the key shapes `signin:magiclink:<ip>:<email>` and
 * `signin:magiclink:ip:<ip>`. A suite that signs several identities in, twice
 * over on a retry, exhausts that inside one run — so the run clears its own
 * buckets first. Product limits are untouched; only the counters are.
 *
 * Talks to Redis through the app's own shared client (`@/lib/server/redis`,
 * driven by REDIS_URL) rather than a container-specific `redis-cli`, so this
 * works identically against the docker-compose Dragonfly and against a CI
 * service container. Fails loudly if Redis is unreachable: a silently skipped
 * flush would surface later as an unexplained 429 in an unrelated test.
 *
 * Usage: bun flush-signin-rate-limit.ts
 */
import { getRedis } from '@/lib/server/redis'

const PATTERN = 'signin:magiclink:*'

const redis = getRedis()

try {
  // SCAN, not KEYS: the pattern is unbounded and Dragonfly/Redis KEYS blocks
  // the server. Cursor iteration may return duplicates, so collect into a Set.
  const found = new Set<string>()
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', PATTERN, 'COUNT', 500)
    cursor = next
    for (const key of batch) found.add(key)
  } while (cursor !== '0')

  // `del` (not the cacheDel wrapper) on purpose: cacheDel swallows Redis
  // errors, which is right for a request path that must not fail on a cache
  // miss and wrong for a test fixture that has to know it did its job.
  const keys = [...found]
  if (keys.length > 0) await redis.del(...keys)

  console.log(JSON.stringify({ action: 'flush-signin-rate-limit', deleted: keys.length }))
  await redis.quit()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
