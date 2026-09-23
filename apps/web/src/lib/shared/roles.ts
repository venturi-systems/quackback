/**
 * Role check helpers
 *
 * Shared between client and server code to eliminate inlined role checks
 * like `['admin', 'member'].includes(role)` scattered across the codebase.
 */

/** Roles used throughout the application. */
export type Role = 'admin' | 'member' | 'user'

/** Returns true if the role is 'admin' or 'member' (i.e. a team member, not a portal user). */
export function isTeamMember(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'member'
}

/** Returns true if the role is 'admin'. */
export function isAdmin(role: string | null | undefined): boolean {
  return role === 'admin'
}

/**
 * The role a principal may actually exercise.
 *
 * Only a human principal (`type: 'user'`) can hold a team role. An anonymous
 * Better Auth principal or a service principal that carries `admin` or
 * `member` (for example one promoted by a pre-fix onboarding call) is capped at
 * `user`, so it can never satisfy a team-role check anywhere a session is
 * resolved. Returns null for an unrecognised role string.
 */
export function effectiveRole(
  role: string | null | undefined,
  principalType: string | null | undefined
): Role | null {
  if (role !== 'admin' && role !== 'member' && role !== 'user') return null
  if (isTeamMember(role) && principalType !== 'user') return 'user'
  return role
}

/**
 * The one vocabulary for workspace roles in every surface: the portal account
 * menu, the sign-in page explainer, the admin restricted state and the docs.
 */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  member: 'Team member',
  user: 'Contributor',
}

/** Display label for a role; unknown or missing roles read as Contributor. */
export function roleLabel(role: string | null | undefined): string {
  return role === 'admin' || role === 'member' ? ROLE_LABELS[role] : ROLE_LABELS.user
}
