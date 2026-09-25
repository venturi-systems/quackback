import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { UserId, StatusId } from '@quackback/ids'
import { generateId } from '@quackback/ids'
import { USE_CASE_TYPES, type SetupState, type UseCaseType } from '@/lib/server/db'
import { effectiveRole } from '@/lib/shared/roles'
import { resolveSessionRole } from '@/lib/server/domains/principals/session-role'
import { getSession, type Session } from '@/lib/server/auth/session'
import { getSettings } from './workspace'
import { requireAuth } from './auth-helpers'
import { syncPrincipalProfile } from '@/lib/server/domains/principals/principal.service'
import { listBoards } from '@/lib/server/domains/boards/board.service'
import {
  db,
  settings,
  principal,
  user,
  postStatuses,
  and,
  eq,
  sql,
  DEFAULT_STATUSES,
} from '@/lib/server/db'
import { invalidateSettingsCache } from '@/lib/server/domains/settings/settings.helpers'
import { DEFAULT_AUTH_CONFIG, DEFAULT_PORTAL_CONFIG } from '@/lib/server/domains/settings'
import { assertNotManaged } from '@/lib/server/config-file/managed-guard'
import { isPathManaged } from '@/lib/server/config-file/managed-paths'
import { slugify } from '@/lib/shared/utils'
import { getSetupState, isOnboardingComplete } from '@/lib/shared/db-types'
import { logger } from '@/lib/server/logger'
import { acquireTeamRoleLock } from '@/lib/server/domains/principals/team-role-lock'

const log = logger.child({ component: 'onboarding' })

/** Refusal messages. Exported so tests assert the exact contract. */
export const ONBOARDING_DENIED = {
  anonymous: 'Access denied: sign in with a full account to set up this workspace',
  notAdmin: 'Access denied: only an administrator can complete setup',
  complete: 'Workspace already initialized',
} as const

/**
 * Onboarding runs before any administrator exists, so it cannot use
 * requireAuth({ roles: ['admin'] }). It must still never hand out admin to an
 * arbitrary caller: an anonymous Better Auth session is free for anyone to
 * mint, and a NULL or partial `setup_state` on a live workspace must not
 * reopen the bootstrap path.
 */
function assertHumanSession(session: Session): void {
  if (session.user.principalType !== 'user') {
    throw new Error(ONBOARDING_DENIED.anonymous)
  }
}

/**
 * Bootstrap admin claim, used by the two onboarding writes
 * (saveUseCaseFn, setupWorkspaceFn).
 *
 * The caller becomes admin only when it is a human principal AND no human
 * admin exists yet. A caller that is already admin is a no-op. Any other
 * caller is refused, whatever `setup_state` says. The check and the write run
 * in one transaction under the same advisory lock as the SSO bootstrap
 * promotion (auth/hooks.ts), so two first sign-ins cannot both claim admin,
 * and under the team-role lock that every write of a person's team role
 * holds (team-role-lock.ts), taken second.
 */
async function claimBootstrapAdmin(session: Session): Promise<void> {
  assertHumanSession(session)
  const userId = session.user.id as UserId
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('quackback:sso_bootstrap'))`)
    await acquireTeamRoleLock(tx)

    const existing = await tx.query.principal.findFirst({
      where: eq(principal.userId, userId),
    })
    if (existing && existing.type !== 'user') {
      throw new Error(ONBOARDING_DENIED.anonymous)
    }
    if (!existing) {
      // A session without a principal row is only legitimate for a human
      // account; never mint an admin principal for an anonymous user row.
      const userRow = await tx.query.user.findFirst({
        where: eq(user.id, userId),
        columns: { isAnonymous: true },
      })
      if (!userRow || userRow.isAnonymous) {
        throw new Error(ONBOARDING_DENIED.anonymous)
      }
    }
    if (existing && effectiveRole(existing.role, existing.type) === 'admin') return

    const humanAdmin = await tx.query.principal.findFirst({
      where: and(eq(principal.role, 'admin'), eq(principal.type, 'user')),
      columns: { id: true },
    })
    if (humanAdmin) {
      log.warn({ user_id: userId }, 'onboarding admin claim refused: an administrator exists')
      throw new Error(ONBOARDING_DENIED.notAdmin)
    }

    // Team identity rule: even the first administrator must be a verified
    // team-domain account from Google or GitHub.
    const { assertTeamRoleAssignable } =
      await import('@/lib/server/domains/principals/team-designation')
    await assertTeamRoleAssignable(userId, tx)

    if (!existing) {
      log.info({ user_id: userId }, 'bootstrap admin: creating admin principal')
      await tx.insert(principal).values({
        id: generateId('principal'),
        userId,
        role: 'admin',
        type: 'user',
        createdAt: new Date(),
      })
    } else {
      log.info({ user_id: userId }, 'bootstrap admin: promoting first human user')
      await tx.update(principal).set({ role: 'admin' }).where(eq(principal.userId, userId))
    }
  })
}

/** Require the caller to already be a human admin (onboarding past the bootstrap step). */
async function assertOnboardingAdmin(session: Session): Promise<void> {
  assertHumanSession(session)
  const principalRecord = await db.query.principal.findFirst({
    where: eq(principal.userId, session.user.id as UserId),
  })
  if (!principalRecord || (await resolveSessionRole(principalRecord, session.user)) !== 'admin') {
    throw new Error(ONBOARDING_DENIED.notAdmin)
  }
}

/**
 * Server functions for onboarding workflow.
 */

// ============================================
// Schemas
// ============================================

const setupWorkspaceSchema = z.object({
  workspaceName: z
    .string()
    .min(2, 'Workspace name must be at least 2 characters')
    .max(100, 'Workspace name must be 100 characters or less'),
  userName: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must be 100 characters or less')
    .optional(),
  useCase: z.enum(USE_CASE_TYPES).optional(),
})

// ============================================
// Type Exports
// ============================================

export type SetupWorkspaceInput = z.infer<typeof setupWorkspaceSchema>

export interface SetupWorkspaceResult {
  id: string
  name: string
  slug: string
}

// ============================================
// Server Functions
// ============================================

/**
 * Setup workspace during onboarding.
 * Creates settings and default statuses.
 * Requires a human session. The caller becomes admin only through
 * claimBootstrapAdmin (no human admin exists yet); once the workspace step is
 * done, only an existing admin may call it.
 *
 * NOTE: Cannot use requireAuth() here because it requires settings to exist,
 * but we're creating settings. We manually check auth and handle member creation.
 */
export const setupWorkspaceFn = createServerFn({ method: 'POST' })
  .validator(setupWorkspaceSchema)
  .handler(async ({ data }: { data: SetupWorkspaceInput }): Promise<SetupWorkspaceResult> => {
    log.debug({ workspace_name: data.workspaceName }, 'setup workspace: entry')
    try {
      // Check authentication manually (can't use requireAuth - it needs settings to exist)
      const session = await getSession()
      if (!session?.user) {
        throw new Error('Authentication required')
      }
      assertHumanSession(session)

      // Block in-app writes when the config-file owns these fields.
      // The reconciler applies the file's value separately; this gate
      // refuses to let the UI clobber it. Pre-onboarding the gate is a
      // no-op because settings (and managedFieldPaths) don't exist yet
      // — by the time managedFieldPaths is populated the reconciler
      // has already written the file's name/slug.
      //
      // Slug-only lock: when the file owns slug but not name, the name
      // input still accepts user submission (the wizard auto-derives
      // slug client-side, but the server skips the slug column write
      // below). This avoids locking the user out of onboarding when
      // only one of the two fields is managed.
      await assertNotManaged('workspace.name')
      if (data.useCase !== undefined) {
        await assertNotManaged('workspace.useCase')
      }

      const { workspaceName, userName, useCase } = data

      // Check if settings already exist
      const existingSettings = await getSettings()

      let setupState: SetupState | null = getSetupState(existingSettings?.setupState ?? null)

      // Workspace step already done: only an existing human admin may continue.
      // Otherwise (fresh install, or settings whose workspace step is not done,
      // including a NULL setup_state) the caller may claim admin only while no
      // human admin exists.
      if (existingSettings && setupState?.steps?.workspace) {
        await assertOnboardingAdmin(session)
      } else {
        await claimBootstrapAdmin(session)
      }

      // Check if onboarding is already complete
      if (isOnboardingComplete(setupState)) {
        throw new Error(ONBOARDING_DENIED.complete)
      }

      // Update user's name if provided (for users created via magic link without a name)
      if (userName) {
        await db
          .update(user)
          .set({
            name: userName.trim(),
            updatedAt: new Date(),
          })
          .where(eq(user.id, session.user.id as UserId))
        await syncPrincipalProfile(session.user.id as UserId, { displayName: userName.trim() })
      }

      let finalSettings = existingSettings

      // Settings exist: update name/slug and mark workspace step complete
      if (existingSettings) {
        log.debug('setup workspace: updating existing settings')

        // Slug is auto-derived from name client-side, but if the
        // config file owns workspace.slug we skip the column write and
        // let the file's slug stand. The reconciler will overwrite it
        // on its next tick anyway.
        const slugManaged = isPathManaged('workspace.slug', existingSettings.managedFieldPaths)
        const slug = slugify(workspaceName)

        if (!slugManaged && slug.length < 2) {
          throw new Error('Invalid workspace name - cannot generate valid slug')
        }

        // Update setupState to mark workspace step as complete
        if (setupState && !setupState.steps.workspace) {
          const updatedState: SetupState = {
            ...setupState,
            steps: {
              ...setupState.steps,
              workspace: true,
            },
            useCase: useCase ?? setupState.useCase,
          }
          const updatePayload: Record<string, unknown> = {
            name: workspaceName.trim(),
            setupState: JSON.stringify(updatedState),
            // Seed defaults only when the column is still null — never
            // clobber values the admin (or config-file reconciler) has
            // already written. openSignup is forced true here so the
            // first admin doesn't lock the team surface immediately
            // after creating the workspace; DEFAULT_AUTH_CONFIG ships
            // false because steady-state tenants don't want anyone to
            // self-serve sign-up.
            portalConfig: existingSettings.portalConfig ?? JSON.stringify(DEFAULT_PORTAL_CONFIG),
            authConfig:
              existingSettings.authConfig ??
              JSON.stringify({ ...DEFAULT_AUTH_CONFIG, openSignup: true }),
          }
          if (!slugManaged) updatePayload.slug = slug
          const [updated] = await db
            .update(settings)
            .set(updatePayload)
            .where(eq(settings.id, existingSettings.id))
            .returning()
          finalSettings = updated
          log.info(
            { workspace_name: workspaceName, slug_managed: slugManaged },
            'setup workspace: settings updated'
          )
        }
      } else {
        // Self-hosted: create settings from scratch
        // Generate slug from workspace name
        const slug = slugify(workspaceName)

        if (slug.length < 2) {
          throw new Error('Invalid workspace name - cannot generate valid slug')
        }

        // Workspace step is done by the time this fn returns; boards
        // step still pending until the user creates / skips one.
        setupState = {
          version: 1,
          steps: {
            core: true,
            workspace: true,
            boards: false,
          },
          useCase,
        }

        // Create settings
        // Note: Not using transaction because neon-http driver doesn't support interactive transactions.
        //
        // Fresh-insert intentionally bypasses the managed-paths gate:
        // there's no settings row yet to read managedFieldPaths from,
        // so assertNotManaged would have nothing to assert against. If
        // a config file is present, the reconciler will overwrite
        // name/slug/etc on its next tick and populate managedFieldPaths
        // — subsequent UI mutators are gated normally.
        const [createdSettings] = await db
          .insert(settings)
          .values({
            id: generateId('workspace'),
            name: workspaceName.trim(),
            slug,
            createdAt: new Date(),
            portalConfig: JSON.stringify(DEFAULT_PORTAL_CONFIG),
            // openSignup forced true at first-install so the bootstrap
            // admin doesn't lock the team surface immediately; the
            // shipped default is false (settings.types.ts).
            authConfig: JSON.stringify({ ...DEFAULT_AUTH_CONFIG, openSignup: true }),
            setupState: JSON.stringify(setupState),
          })
          .returning()

        finalSettings = createdSettings
        log.info('setup workspace: created settings')
      }

      // Create default post statuses if none exist
      const existingStatuses = await db.query.postStatuses.findFirst()
      if (!existingStatuses) {
        const statusValues = DEFAULT_STATUSES.map((status) => ({
          id: generateId('status') as StatusId,
          ...status,
          createdAt: new Date(),
        }))
        await db.insert(postStatuses).values(statusValues)
        log.info({ count: statusValues.length }, 'setup workspace: created default statuses')
      }

      await invalidateSettingsCache()
      log.info(
        { workspace_id: finalSettings!.id, slug: finalSettings!.slug },
        'setup workspace: complete'
      )
      return {
        id: finalSettings!.id,
        name: finalSettings!.name,
        slug: finalSettings!.slug,
      }
    } catch (error) {
      log.error({ err: error }, 'setup workspace failed')
      throw error
    }
  })

/**
 * Save user name during onboarding.
 * Called after OTP verification if user doesn't have a name set.
 */
export const saveUserNameFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      name: z.string().min(2, 'Name must be at least 2 characters').max(100),
    })
  )
  .handler(async ({ data }: { data: { name: string } }): Promise<void> => {
    log.debug('save user name: entry')
    try {
      const session = await getSession()
      if (!session?.user) {
        throw new Error('Authentication required')
      }

      await db
        .update(user)
        .set({
          name: data.name.trim(),
          updatedAt: new Date(),
        })
        .where(eq(user.id, session.user.id as UserId))
      await syncPrincipalProfile(session.user.id as UserId, { displayName: data.name.trim() })

      log.info({ user_id: session.user.id }, 'save user name: saved')
    } catch (error) {
      log.error({ err: error }, 'save user name failed')
      throw error
    }
  })

/**
 * Save use case selection during onboarding.
 * Stores the use case in setupState for board recommendations.
 * For fresh installs, creates minimal settings to store the useCase.
 */
export const saveUseCaseFn = createServerFn({ method: 'POST' })
  .validator(z.object({ useCase: z.enum(USE_CASE_TYPES) }))
  .handler(async ({ data }: { data: { useCase: UseCaseType } }): Promise<void> => {
    log.debug({ use_case: data.useCase }, 'save use case: entry')
    try {
      const session = await getSession()
      if (!session?.user) {
        throw new Error('Authentication required')
      }
      assertHumanSession(session)

      // Same rationale as setupWorkspaceFn: don't let the UI overwrite
      // a file-managed useCase. Pre-onboarding the gate is a no-op.
      await assertNotManaged('workspace.useCase')

      const existingSettings = await getSettings()

      if (existingSettings) {
        const storedState = getSetupState(existingSettings.setupState)
        // A finished workspace is never re-onboarded through this endpoint.
        if (isOnboardingComplete(storedState)) {
          throw new Error(ONBOARDING_DENIED.complete)
        }
        const setupState: SetupState = storedState ?? {
          version: 1,
          steps: { core: true, workspace: false, boards: false },
        }

        // Authorize BEFORE writing: past the workspace step only an existing
        // human admin may change the use case; before it, the caller must be
        // able to claim the bootstrap admin role.
        if (setupState.steps.workspace) {
          await assertOnboardingAdmin(session)
        } else {
          await claimBootstrapAdmin(session)
        }

        const updatedState: SetupState = { ...setupState, useCase: data.useCase }

        await db
          .update(settings)
          .set({ setupState: JSON.stringify(updatedState) })
          .where(eq(settings.id, existingSettings.id))

        await invalidateSettingsCache()
        log.info({ use_case: data.useCase }, 'save use case: saved')
      } else {
        // Fresh install: create minimal settings to store useCase. The
        // workspace step will update name/slug later.
        //
        // Fresh-insert intentionally bypasses the managed-paths gate
        // (same rationale as setupWorkspaceFn): no settings row yet to
        // read managedFieldPaths from. The reconciler will overwrite on
        // its next tick if the file owns these fields.
        const setupState: SetupState = {
          version: 1,
          steps: { core: true, workspace: false, boards: false },
          useCase: data.useCase,
        }

        // Claim admin first so a refused caller never creates settings.
        await claimBootstrapAdmin(session)

        await db.insert(settings).values({
          id: generateId('workspace'),
          name: 'My Workspace', // Placeholder, will be updated in workspace step
          slug: 'workspace',
          createdAt: new Date(),
          setupState: JSON.stringify(setupState),
        })

        await invalidateSettingsCache()
        log.info({ use_case: data.useCase }, 'save use case: created initial settings')
      }
    } catch (error) {
      log.error({ err: error }, 'save use case failed')
      throw error
    }
  })

/**
 * Check onboarding state for the CALLER.
 *
 * The caller is resolved from the session cookie; no client-supplied user id
 * is accepted, and this GET never writes. The bootstrap admin principal is
 * created only by the onboarding POST writes (saveUseCaseFn /
 * setupWorkspaceFn via claimBootstrapAdmin).
 *
 * `needsInvitation` is true when the caller cannot become or act as the
 * workspace admin: an anonymous session, or a non-admin while a human admin
 * already exists.
 */
export const checkOnboardingState = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('check onboarding state')
  try {
    const session = await getSession()
    if (!session?.user) {
      log.debug('check onboarding state: no session')
      return {
        principalRecord: null,
        hasSettings: false,
        setupState: null,
        isOnboardingComplete: false,
      }
    }

    const needsInvitation = {
      principalRecord: null,
      needsInvitation: true,
      hasSettings: false,
      setupState: null,
      isOnboardingComplete: false,
    }

    if (session.user.principalType !== 'user') {
      log.debug('check onboarding state: anonymous session')
      return needsInvitation
    }

    const principalRecord = await db.query.principal.findFirst({
      where: eq(principal.userId, session.user.id as UserId),
    })
    const role = principalRecord ? await resolveSessionRole(principalRecord, session.user) : null

    if (principalRecord && principalRecord.type !== 'user') {
      return needsInvitation
    }

    if (role !== 'admin') {
      // Check if any human admin exists (exclude service principals)
      const existingAdmin = await db.query.principal.findFirst({
        where: and(eq(principal.role, 'admin'), eq(principal.type, 'user')),
        columns: { id: true },
      })
      if (existingAdmin) {
        // Not the first user - they need an invitation
        log.debug({ needs_invitation: true }, 'check onboarding state')
        return needsInvitation
      }
    }

    // Get settings to check setup state
    const currentSettings = await getSettings()
    const setupState = getSetupState(currentSettings?.setupState ?? null)
    const onboardingComplete = isOnboardingComplete(setupState)

    log.debug(
      { setup_state: setupState, is_complete: onboardingComplete },
      'check onboarding state'
    )
    return {
      principalRecord: principalRecord
        ? {
            id: principalRecord.id,
            userId: principalRecord.userId,
            role: role ?? 'user',
          }
        : null,
      needsInvitation: false,
      hasSettings: !!currentSettings,
      setupState,
      isOnboardingComplete: onboardingComplete,
    }
  } catch (error) {
    log.error({ err: error }, 'check onboarding state failed')
    throw error
  }
})

/**
 * List existing boards during onboarding plus the tenant's maxBoards
 * tier limit. The wizard's boards step uses both — the first to
 * display existing boards as completed, the second to render the
 * selector as radio-style (single-select) when only one board fits.
 */
export const listBoardsForOnboarding = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('list boards for onboarding: entry')
  // Every board (including protected ones) is listed here, so only a human
  // admin may read it. Anyone else (no session, portal user, team member,
  // anonymous session) gets the same empty shape, so the response is not an
  // oracle for board names, ids or descriptions.
  try {
    await requireAuth({ roles: ['admin'] })
  } catch {
    log.debug('list boards for onboarding: caller is not an admin')
    return { boards: [], maxBoards: null }
  }
  try {
    const { getTierLimits } = await import('@/lib/server/domains/settings/tier-limits.service')
    const [boardList, limits] = await Promise.all([listBoards(), getTierLimits()])
    return {
      boards: boardList.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
      })),
      maxBoards: limits.maxBoards,
    }
  } catch (error) {
    log.error({ err: error }, 'list boards for onboarding failed')
    return { boards: [], maxBoards: null }
  }
})
