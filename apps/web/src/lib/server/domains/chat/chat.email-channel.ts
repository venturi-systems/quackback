/**
 * Inbound email channel config + plus-address routing, kept pure so it's
 * unit-tested directly. The widget's outbound agent-reply emails set a
 * conversation-specific Reply-To (`reply+<conversationId>.<sig>@<inbound-domain>`);
 * the inbound webhook reads that plus-address back to route a reply into the
 * right conversation. The `<sig>` is an HMAC of the conversation id under the
 * workspace's inbound signing secret, so a third party who receives one of our
 * reply emails cannot forge a reply-to for an ARBITRARY conversation and inject
 * messages as another visitor — the webhook signature only proves the provider
 * forwarded the mail, not the SMTP sender's identity. Both are gated on inbound
 * being configured.
 */
import { createHmac, timingSafeEqual } from 'crypto'

type EnvLike = Record<string, string | undefined>

const INBOUND_DOMAIN_ENV = 'EMAIL_INBOUND_DOMAIN'
const INBOUND_SECRET_ENV = 'EMAIL_INBOUND_SIGNING_SECRET'

// base64url chars of the HMAC-SHA256 tag embedded in the plus-address. 22 chars
// is ~132 bits — far beyond what's needed to make the id unforgeable, while
// keeping the local-part short.
const SIG_LEN = 22

/** Decode the `whsec_<base64>` signing secret to raw key bytes, or null. */
function signingKey(env: EnvLike): Buffer | null {
  const secret = env[INBOUND_SECRET_ENV]
  if (!secret) return null
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return key.byteLength > 0 ? key : null
}

/** Inbound email is usable only when both the receiving domain and the webhook
 *  signing secret are configured. When false, the inbound route 404s and no
 *  routable Reply-To is emitted. */
export function isEmailInboundConfigured(env: EnvLike = process.env): boolean {
  return Boolean(env[INBOUND_DOMAIN_ENV] && env[INBOUND_SECRET_ENV])
}

/** HMAC tag binding a conversation id to this workspace's inbound secret, or
 *  null when no secret is configured. */
export function signConversationId(
  conversationId: string,
  env: EnvLike = process.env
): string | null {
  const key = signingKey(env)
  if (!key) return null
  return createHmac('sha256', key).update(conversationId).digest('base64url').slice(0, SIG_LEN)
}

/** `reply+<conversationId>.<sig>@<inbound-domain>`, or null when the inbound
 *  domain or signing secret is missing. */
export function inboundReplyToAddress(
  conversationId: string,
  env: EnvLike = process.env
): string | null {
  const domain = env[INBOUND_DOMAIN_ENV]
  const sig = signConversationId(conversationId, env)
  if (!domain || !sig) return null
  return `reply+${conversationId}.${sig}@${domain}`
}

/** Extract + verify the conversation id from a `reply+<id>.<sig>@domain`
 *  recipient. Returns the id only when the signature matches (constant-time);
 *  an unsigned, tampered, or wrong-secret address yields null so a forged
 *  reply-to can't route into someone else's conversation. */
export function conversationIdFromInboundAddress(
  address: string,
  env: EnvLike = process.env
): string | null {
  const match = /reply\+([^@>\s]+)@/i.exec(address)
  if (!match) return null
  const local = match[1]
  // id and sig are both dot-free (TypeID base32 + base64url), so the last dot
  // is an unambiguous separator.
  const dot = local.lastIndexOf('.')
  if (dot === -1) return null
  const id = local.slice(0, dot)
  const provided = local.slice(dot + 1)
  const expected = signConversationId(id, env)
  if (!expected) return null
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) return null
  return id
}
