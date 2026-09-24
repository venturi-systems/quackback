/**
 * The deployment's rule for the "Anyone" (anonymous) tier on boards.
 *
 * When POLICY_MANAGED_SETTINGS declares `boards.anonymousAccess`, an external
 * policy process owns that tier. For Venturi it is the feedback
 * infrastructure repository's reconciler, whose database guard holds every
 * board outside its published allowlist to signed-in tiers: it rewrites an
 * anonymous tier on insert and rejects one on update with a raw database
 * error (feedback#237, DEF-42). The app applies the same rule first, so an
 * administrator gets a clean 403 FIELD_MANAGED that explains it instead of a
 * board that silently differs from what was chosen, or a server error.
 *
 * Read from the environment only, like isBoardAccessPolicyManaged: board
 * access is never a config-file managed path.
 */
import { config } from '@/lib/server/config'
import { isPathManaged } from '@/lib/server/config-file/managed-paths'
import { BOARD_ANONYMOUS_ACCESS_PATH } from '@/lib/shared/policy-managed-paths'
import { ForbiddenError } from '@/lib/shared/errors'
import { DEFAULT_BOARD_ACCESS, type BoardAccess } from '@/lib/shared/db-types'

const BOARD_ACTIONS = ['view', 'vote', 'comment', 'submit'] as const
type BoardAction = (typeof BOARD_ACTIONS)[number]

/** True when the deployment's policy owns the "Anyone" tier on boards. */
export function isBoardAnonymousAccessPolicyManaged(): boolean {
  const managed = config.policyManagedSettings
  return Array.isArray(managed) && isPathManaged(BOARD_ANONYMOUS_ACCESS_PATH, managed)
}

/** The actions an access matrix opens to the anonymous tier, in display order. */
export function anonymousTierActions(access: BoardAccess): BoardAction[] {
  return BOARD_ACTIONS.filter((action) => access[action] === 'anonymous')
}

/**
 * Refuse an access matrix that gives any action the anonymous tier while the
 * policy owns that tier. Call it only for access the caller chose; a default
 * goes through defaultAccessWithinPolicy instead.
 */
export function assertBoardAccessWithinPolicy(access: BoardAccess): void {
  if (!isBoardAnonymousAccessPolicyManaged()) return
  const actions = anonymousTierActions(access)
  if (actions.length === 0) return
  throw new ForbiddenError(
    'FIELD_MANAGED',
    `Field "${BOARD_ANONYMOUS_ACCESS_PATH}" is managed: this deployment's access policy ` +
      `requires sign-in on every board it does not manage, so the "Anyone" tier ` +
      `cannot be used (requested for ${actions.join(', ')}). ` +
      `Choose Signed-in, Segments or Team only.`
  )
}

/**
 * The access a new board gets when its caller did not choose one (the REST
 * create endpoint and the onboarding batch). Unchanged unless the policy owns
 * the anonymous tier; then every anonymous action starts at the signed-in
 * tier, the most open tier the policy allows. Raising the lowest rank to the
 * next keeps boardAccessSchema's rank invariants (no action more open than
 * view), and segments and moderation are kept as they are.
 */
export function defaultAccessWithinPolicy(access: BoardAccess = DEFAULT_BOARD_ACCESS): BoardAccess {
  if (!isBoardAnonymousAccessPolicyManaged()) return access
  const next: BoardAccess = structuredClone(access)
  for (const action of BOARD_ACTIONS) {
    if (next[action] === 'anonymous') next[action] = 'authenticated'
  }
  return next
}
