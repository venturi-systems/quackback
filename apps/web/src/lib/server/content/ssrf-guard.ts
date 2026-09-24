/**
 * SSRF-guard helpers for server-side outbound fetches.
 *
 * Validates that a URL is safe to fetch from the server:
 * - scheme allow-list (http/https only)
 * - DNS resolution with every returned address checked by
 *   `isPrivateAddress`: parsed with `node:net`, IPv4-mapped IPv6 judged
 *   as the IPv4 address it carries, and every non-global or
 *   special-purpose range refused
 * - returns the resolved IP so the caller can pin it across the fetch
 *   and close DNS-rebinding TOCTOU windows
 *
 * `safeFetch` is the pinned-fetch primitive: validate, then connect to
 * the *validated IP* — never re-resolving the hostname — so a DNS
 * rebind between the check and the connect cannot redirect the request
 * at a private address. Prefer it over `checkUrlSafety` + `fetch`.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { checkServerIdentity } from 'node:tls'
import type { IncomingMessage } from 'node:http'

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/** Return true if the URL parses and uses http or https. */
export function isSafeScheme(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_SCHEMES.has(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * Parse an IPv4 dotted quad to a 32-bit unsigned number. Only the canonical
 * form `node:net`'s `isIP` accepts parses (four decimal octets, no leading
 * zeros); anything else is null and fails closed in `isPrivateAddress`.
 */
function parseIpv4(addr: string): number | null {
  if (isIP(addr) !== 4) return null
  return addr.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0)
}

/**
 * Parse IPv6 text to its eight 16-bit groups, or null. Accepts every form
 * `node:net`'s `isIP` accepts: `::` compression, any letter case, an embedded
 * dotted-quad tail (`::ffff:127.0.0.1`) and a zone index (`fe80::1%eth0`),
 * which is dropped.
 */
function parseIpv6(addr: string): number[] | null {
  const zone = addr.indexOf('%')
  let text = (zone === -1 ? addr : addr.slice(0, zone)).toLowerCase()
  if (isIP(text) !== 6) return null
  // A dotted-quad tail is the last two groups written in decimal.
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail)
    if (v4 === null) return null
    const high = (v4 >>> 16).toString(16)
    const low = (v4 & 0xffff).toString(16)
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groupsOf = (part: string) =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16))
  const head = groupsOf(halves[0])
  const rest = halves.length === 2 ? groupsOf(halves[1]) : []
  const zeros = 8 - head.length - rest.length
  if (halves.length === 2 ? zeros < 1 : zeros !== 0) return null
  const groups = [...head, ...new Array<number>(zeros).fill(0), ...rest]
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

type Ipv4Range = { base: number; mask: number }
type Ipv6Prefix = { groups: number[]; bits: number }

function ipv4Range(cidr: string): Ipv4Range {
  const [base, bits] = cidr.split('/')
  const parsed = parseIpv4(base)
  if (parsed === null) throw new Error(`invalid IPv4 range ${cidr}`)
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  return { base: (parsed & mask) >>> 0, mask }
}

function ipv6Prefix(cidr: string): Ipv6Prefix {
  const [base, bits] = cidr.split('/')
  const groups = parseIpv6(base)
  if (groups === null) throw new Error(`invalid IPv6 prefix ${cidr}`)
  return { groups, bits: Number(bits) }
}

function inIpv4Range(ip: number, { base, mask }: Ipv4Range): boolean {
  return ((ip & mask) >>> 0) === base
}

function inIpv6Prefix(groups: number[], prefix: Ipv6Prefix): boolean {
  for (let i = 0; i * 16 < prefix.bits; i++) {
    const take = Math.min(16, prefix.bits - i * 16)
    const mask = (0xffff << (16 - take)) & 0xffff
    if ((groups[i] & mask) !== (prefix.groups[i] & mask)) return false
  }
  return true
}

/**
 * IPv4 ranges a server-side fetch must never reach: every range the IANA IPv4
 * Special-Purpose Address Registry marks as not globally reachable, plus
 * multicast and the deprecated 6to4 relay anycast block. This guard serves
 * webhooks, image rehosting and OIDC: tighten it, never loosen it.
 */
const BLOCKED_IPV4 = [
  '0.0.0.0/8', // "this network" (RFC 791), including 0.0.0.0 "this host"
  '10.0.0.0/8', // private use (RFC 1918)
  '100.64.0.0/10', // shared address space, CGNAT (RFC 6598)
  '127.0.0.0/8', // loopback (RFC 1122)
  '169.254.0.0/16', // link-local (RFC 3927), including cloud metadata 169.254.169.254
  '172.16.0.0/12', // private use (RFC 1918)
  '192.0.0.0/24', // IETF protocol assignments (RFC 6890), including 192.0.0.8 and 192.0.0.170/171
  '192.0.2.0/24', // documentation, TEST-NET-1 (RFC 5737)
  '192.88.99.0/24', // deprecated 6to4 relay anycast (RFC 7526)
  '192.168.0.0/16', // private use (RFC 1918)
  '198.18.0.0/15', // benchmarking (RFC 2544)
  '198.51.100.0/24', // documentation, TEST-NET-2 (RFC 5737)
  '203.0.113.0/24', // documentation, TEST-NET-3 (RFC 5737)
  '224.0.0.0/4', // multicast (RFC 5771)
  '240.0.0.0/4', // reserved (RFC 1112), including limited broadcast 255.255.255.255
].map(ipv4Range)

/**
 * Global unicast (RFC 4291 2.4). IANA allocates public IPv6 space only from
 * 2000::/3, so an address outside it is never a legitimate fetch target. That
 * one rule blocks the unspecified and loopback addresses, IPv4-compatible
 * (`::/96`, e.g. `::7f00:1`) and IPv4-translated (`::ffff:0:0:0/96`) forms,
 * NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), discard-only `100::/64`, SRv6
 * `5f00::/16`, unique-local `fc00::/7`, link-local `fe80::/10`, deprecated
 * site-local `fec0::/10`, multicast `ff00::/8` and all unallocated space.
 */
const GLOBAL_UNICAST_IPV6 = ipv6Prefix('2000::/3')

/**
 * Prefixes inside 2000::/3 that are still not fetch targets: the IANA IPv6
 * Special-Purpose Address Registry's non-global entries, and the transition
 * ranges that embed an attacker-chosen IPv4 address.
 */
const BLOCKED_GLOBAL_IPV6 = [
  '2001::/23', // IETF protocol assignments (RFC 2928): Teredo 2001::/32, benchmarking, ORCHID
  '2001:db8::/32', // documentation (RFC 3849)
  '2002::/16', // 6to4 (RFC 3056): embeds an IPv4 address
  '3fff::/20', // documentation (RFC 9637)
].map(ipv6Prefix)

/** IPv4-mapped IPv6, `::ffff:0:0/96` (RFC 4291 2.5.5.2). */
const IPV4_MAPPED = ipv6Prefix('::ffff:0:0/96')

function isBlockedIpv4(ip: number): boolean {
  return BLOCKED_IPV4.some((range) => inIpv4Range(ip, range))
}

function isBlockedIpv6(groups: number[]): boolean {
  // An IPv4-mapped address is dialled as the IPv4 address it carries, so it is
  // judged as that address: `::ffff:8.8.8.8` is public, `::ffff:7f00:1` is not.
  if (inIpv6Prefix(groups, IPV4_MAPPED)) {
    return isBlockedIpv4(((groups[6] << 16) | groups[7]) >>> 0)
  }
  if (!inIpv6Prefix(groups, GLOBAL_UNICAST_IPV6)) return true
  return BLOCKED_GLOBAL_IPV6.some((prefix) => inIpv6Prefix(groups, prefix))
}

/**
 * Is the given textual IP address one a server-side fetch must not reach? True
 * for private, loopback, link-local, special-purpose and non-global addresses,
 * and for anything that does not parse as an IP address: this guard fails
 * closed.
 */
export function isPrivateAddress(addr: string): boolean {
  if (addr.includes(':')) {
    const groups = parseIpv6(addr)
    return groups === null || isBlockedIpv6(groups)
  }
  const ip = parseIpv4(addr)
  return ip === null || isBlockedIpv4(ip)
}

export type UrlSafetyResult =
  | { safe: true; address: string; family: 4 | 6 }
  | { safe: false; reason: 'scheme-rejected' | 'ssrf-rejected' | 'dns-error' }

/**
 * Check that a URL is safe to fetch from the server.
 *
 * On success, returns the first public address that was resolved — the
 * caller should use this address to pin the fetch connection (e.g. via a
 * custom agent lookup function) to close the DNS rebinding TOCTOU window.
 */
export async function checkUrlSafety(url: string): Promise<UrlSafetyResult> {
  if (!isSafeScheme(url)) {
    return { safe: false, reason: 'scheme-rejected' }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { safe: false, reason: 'scheme-rejected' }
  }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(parsed.hostname, { all: true })
  } catch {
    return { safe: false, reason: 'dns-error' }
  }
  if (addresses.length === 0) {
    return { safe: false, reason: 'dns-error' }
  }
  // Reject if ANY resolved address is private — we won't know which one the
  // fetch would connect to without pinning.
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      return { safe: false, reason: 'ssrf-rejected' }
    }
  }
  const pinned = addresses[0]
  return {
    safe: true,
    address: pinned.address,
    family: pinned.family === 6 ? 6 : 4,
  }
}

/** Thrown by `safeFetch` when the target URL fails SSRF validation. */
export class SsrfError extends Error {
  constructor(public readonly reason: 'scheme-rejected' | 'ssrf-rejected' | 'dns-error') {
    super(`URL rejected by SSRF guard: ${reason}`)
    this.name = 'SsrfError'
  }
}

/** Thrown by `safeFetch` when the body exceeds the cap and `onOverflow: 'error'`. */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxResponseBytes: number) {
    super(`safeFetch: response body exceeded ${maxResponseBytes} bytes`)
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Thrown by `safeFetch` when the peer answers with a status a `Response`
 * cannot carry (outside 200-599: a 1xx as the final status, or 600+).
 */
export class InvalidResponseStatusError extends Error {
  constructor(public readonly status: number) {
    super(`safeFetch: unusable response status ${status}`)
    this.name = 'InvalidResponseStatusError'
  }
}

/** Thrown by `safeFetch` when the request exceeds `timeoutMs`. */
export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`safeFetch: request timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
  }
}

export interface SafeFetchInit {
  method?: string
  headers?: Record<string, string>
  /** Request body for POST/PUT. */
  body?: string
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number
  /** Hard cap on the buffered response body. Default 64 KiB. */
  maxResponseBytes?: number
  /**
   * What to do when the body exceeds `maxResponseBytes`:
   * - `'truncate'` (default): cut the stream and resolve with the bytes that
   *   arrived before the cap. Right for JSON metadata endpoints (JWKS, OIDC).
   * - `'error'`: reject with `ResponseTooLargeError`. Right for callers that
   *   must not act on a partial body (e.g. image rehosting).
   */
  onOverflow?: 'truncate' | 'error'
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024

/**
 * SSRF-safe HTTP(S) fetch.
 *
 * Validates the host via `checkUrlSafety`, then connects to the
 * *validated IP literal* — never re-resolving the hostname — closing
 * the DNS-rebinding TOCTOU window that `checkUrlSafety` + `fetch`
 * leaves open (the bare `fetch` does its own second resolution).
 *
 * - The connection target is pinned to the validated IP; TLS SNI and
 *   certificate identity are validated against the *original*
 *   hostname, so vhosted IdPs route correctly and the cert still has
 *   to match the real name.
 * - Redirects are never followed — a 3xx is returned verbatim.
 *   Following it would re-resolve an unvalidated host.
 * - The body is buffered with a hard `maxResponseBytes` cap and
 *   returned as a standard `Response`, so a hostile peer cannot
 *   stream an unbounded body.
 *
 * Throws `SsrfError` on validation failure; rejects with the
 * underlying error on network failure / timeout.
 */
export async function safeFetch(url: string, init: SafeFetchInit = {}): Promise<Response> {
  const safety = await checkUrlSafety(url)
  if (!safety.safe) throw new SsrfError(safety.reason)

  const parsed = new URL(url)
  const isHttps = parsed.protocol === 'https:'
  const requestFn = isHttps ? httpsRequest : httpRequest
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    onOverflow = 'truncate',
  } = init

  return new Promise<Response>((resolve, reject) => {
    const req = requestFn(
      {
        // Connection target: the validated IP. No second DNS lookup
        // happens because this is an address literal, so the TOCTOU
        // window between validation and connect is closed.
        hostname: safety.address,
        family: safety.family,
        port: Number(parsed.port || (isHttps ? 443 : 80)),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        // SNI + HTTP Host carry the original hostname; the cert is
        // validated against it, not the IP we dialled.
        servername: isHttps ? parsed.hostname : undefined,
        headers: { ...headers, host: parsed.host },
        // `timeout` is a socket-inactivity timeout; `signal` adds a hard
        // wall-clock deadline so a peer can't hold the connection open by
        // dribbling bytes just under the inactivity window (slow-loris).
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        checkServerIdentity: isHttps
          ? (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) =>
              checkServerIdentity(parsed.hostname, cert)
          : undefined,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        let total = 0
        // Runs inside the response's event listeners, so it must never throw:
        // an exception there escapes this promise (an uncaught exception) and
        // leaves it pending forever. Every failure rejects instead.
        const finish = () => {
          const status = res.statusCode ?? 502
          if (status < 200 || status > 599) {
            reject(new InvalidResponseStatusError(status))
            return
          }
          // Null-body statuses: the Response constructor refuses a body on them.
          const nullBody = status === 204 || status === 205 || status === 304
          const headerEntries: [string, string][] = []
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headerEntries.push([k, v])
            else if (Array.isArray(v)) headerEntries.push([k, v.join(', ')])
          }
          try {
            resolve(
              new Response(nullBody ? null : Buffer.concat(chunks), {
                status,
                statusText: res.statusMessage ?? '',
                headers: headerEntries,
              })
            )
          } catch (err) {
            // e.g. a status text or header value the Response refuses.
            reject(err)
          }
        }
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > maxResponseBytes) {
            // Over cap: cut the stream either way. In 'error' mode reject so
            // the caller never acts on a partial body; otherwise keep what
            // arrived before the over-cap chunk and resolve with it.
            res.destroy()
            if (onOverflow === 'error') {
              reject(new ResponseTooLargeError(maxResponseBytes))
              return
            }
            finish()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', finish)
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new TimeoutError(timeoutMs)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
