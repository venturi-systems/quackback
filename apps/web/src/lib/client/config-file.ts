/**
 * Client-side helpers for the declarative Quackback config lock.
 *
 * Mirrors `lib/server/config-file/managed-paths.isPathManaged` so
 * client form components don't import server-only modules. Pulled into
 * its own file rather than re-exporting because TanStack Start trips
 * on cross-boundary imports of any module that touches the server tree.
 */

export const MANAGED_PATHS = {
  WORKSPACE_NAME: 'workspace.name',
  WORKSPACE_SLUG: 'workspace.slug',
  WORKSPACE_USE_CASE: 'workspace.useCase',
  TIER_LIMITS: 'tierLimits',
  // Declared by POLICY_MANAGED_SETTINGS when an external policy process owns
  // them (lib/shared/policy-managed-paths.ts). One board's access is
  // boardAccessManagedPath(slug); one sign-in method is
  // authOauthManagedPath(id); the Anyone tier on boards is
  // BOARD_ANONYMOUS_ACCESS_PATH in that file.
  PORTAL_VISIBILITY: 'portal.access.visibility',
  ALLOW_ANONYMOUS: 'portal.features.allowAnonymous',
  AUTH_OAUTH: 'auth.oauth',
} as const

export { authOauthManagedPath, boardAccessManagedPath } from '@/lib/shared/policy-managed-paths'

export type ManagedPath = (typeof MANAGED_PATHS)[keyof typeof MANAGED_PATHS] | (string & {})

export function isPathManagedFromBootstrap(path: string, managed: string[]): boolean {
  for (const m of managed) {
    if (path === m) return true
    if (path.startsWith(`${m}.`)) return true
  }
  return false
}
