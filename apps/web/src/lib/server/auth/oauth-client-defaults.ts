/**
 * OAuth client registration policy for the MCP authorization server.
 *
 * - Registration without a signed-in session is never allowed: it would let
 *   any internet caller create oauth_client rows. There is no switch to allow
 *   it (landing-page#2309).
 * - A dynamically registered client gets read-only scopes by default. A client
 *   that needs a write scope asks for it, and the user consents to it.
 *
 * Kept apart from auth/index.ts so the policy is testable without building
 * the Better Auth instance.
 */

export const ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION = false as const

export const OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'read:feedback',
  'read:article',
] as const
