/**
 * Simple in-memory rate limiter for API authentication
 *
 * Uses a sliding window algorithm to track request counts per IP.
 * Designed to prevent brute-force attacks on API key authentication.
 *
 * SECURITY NOTE: This trusts proxy headers (cf-connecting-ip, x-forwarded-for).
 * The application MUST be deployed behind a trusted reverse proxy (Cloudflare, nginx)
 * that sets these headers. Direct exposure to the internet allows header spoofing.
 */

interface RateLimitEntry {
  count: number
  windowStart: number
}

const rateLimitStore = new Map<string, RateLimitEntry>()
let tierLimitsModule:
  Promise<typeof import('@/lib/server/domains/settings/tier-limits.service')> | undefined

// Configuration
const WINDOW_MS = 60_000 // 1 minute
const MAX_REQUESTS = 100 // 100 requests per minute per IP — used when tier limit is null (OSS)
const IMPORT_MIN = 2000 // Floor for import-mode caps so a tight per-minute tier doesn't choke bulk imports
const MAX_STORE_SIZE = 50_000 // Cap store size to prevent memory exhaustion
const CLEANUP_INTERVAL_MS = 60_000 // Cleanup every minute

// Cleanup old entries periodically
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function startCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of rateLimitStore.entries()) {
      if (now - entry.windowStart > WINDOW_MS) {
        rateLimitStore.delete(key)
      }
    }
  }, CLEANUP_INTERVAL_MS)
  // Don't prevent process from exiting
  cleanupTimer.unref?.()
}

startCleanup()

/**
 * Check if a request is rate limited.
 *
 * @param ip - The client IP address
 * @param importMode - Whether the request is in import mode (higher limit)
 * @returns Object with allowed flag and remaining requests
 *
 * Tier-aware: when settings.tier_limits has a non-null apiRequestsPerMinute,
 * that value overrides the default cap. Import mode multiplies the per-minute
 * cap by 20 (matching the historical 100 -> 2000 ratio).
 *
 * Self-hosters with no tier_limits row get null and fall back to MAX_REQUESTS.
 */
interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfter?: number
}

interface RateLimitAttempt {
  result: RateLimitResult
  key: string
  entry?: RateLimitEntry
}

async function consumeRateLimit(ip: string, importMode = false): Promise<RateLimitAttempt> {
  const now = Date.now()
  const { getTierLimits } = await (tierLimitsModule ??=
    import('@/lib/server/domains/settings/tier-limits.service'))
  const limits = await getTierLimits()
  const baseLimit = limits.apiRequestsPerMinute ?? MAX_REQUESTS
  const maxRequests = importMode ? Math.max(baseLimit * 20, IMPORT_MIN) : baseLimit
  // Only an authenticated administrator may select the import budget. Keep it
  // separate so successful bulk imports do not exhaust normal authentication.
  const key = `${importMode ? 'import' : 'normal'}:${ip}`
  let entry = rateLimitStore.get(key)

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    if (rateLimitStore.size >= MAX_STORE_SIZE && !entry) {
      return { key, result: { allowed: false, remaining: 0, retryAfter: 60 } }
    }
    entry = { count: 1, windowStart: now }
    rateLimitStore.set(key, entry)
    return { key, entry, result: { allowed: true, remaining: maxRequests - 1 } }
  }

  if (entry.count >= maxRequests) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000)
    return { key, result: { allowed: false, remaining: 0, retryAfter } }
  }
  entry.count++
  return { key, entry, result: { allowed: true, remaining: maxRequests - entry.count } }
}

/** Charge the normal budget, or the import budget after administrator authorization. */
export async function checkRateLimit(ip: string, importMode?: boolean): Promise<RateLimitResult> {
  return (await consumeRateLimit(ip, importMode)).result
}

/**
 * Reserve normal capacity before any credential lookup. Only a fully authorized
 * admin import refunds it, after the separate import budget accepts the request.
 * Invalid credentials, insufficient roles/scopes and rejected imports retain
 * their charge. In-flight requests count until authorization completes.
 */
export async function reserveAuthenticationAttempt(
  ip: string
): Promise<RateLimitResult & { refund: () => void }> {
  const attempt = await consumeRateLimit(ip)
  let active = attempt.result.allowed
  return {
    ...attempt.result,
    refund() {
      if (!active) return
      active = false
      // A delayed completion must never refund a later window or a new entry.
      if (attempt.entry && rateLimitStore.get(attempt.key) === attempt.entry) {
        attempt.entry.count = Math.max(0, attempt.entry.count - 1)
      }
    },
  }
}

/**
 * Extract client IP from request headers.
 * Checks common proxy headers for the real client IP.
 *
 * Accepts a full `Request` or just `Headers` — server functions only
 * have `Headers` via `getRequestHeaders()`, so the Headers overload
 * lets them call this without forging a synthetic Request.
 */
export function getClientIp(source: Request | Headers): string {
  const headers = source instanceof Headers ? source : source.headers

  // Check Cloudflare header first
  const cfIp = headers.get('cf-connecting-ip')
  if (cfIp) return cfIp

  // Check X-Forwarded-For (may contain comma-separated list)
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const firstIp = forwarded.split(',')[0].trim()
    if (firstIp) return firstIp
  }

  // Check X-Real-IP
  const realIp = headers.get('x-real-ip')
  if (realIp) return realIp

  // Fallback to unknown
  return 'unknown'
}
