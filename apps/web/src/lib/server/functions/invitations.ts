import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { z } from 'zod'
import type { InviteId, UserId } from '@quackback/ids'
import { isValidTypeId } from '@quackback/ids'
import { db, invitation, principal, user, and, eq, or } from '@/lib/server/db'
import { getPublicUrlOrNull } from '@/lib/server/storage/s3'
import { getSession } from '@/lib/server/auth/session'
import { logger } from '@/lib/server/logger'
import { filterId } from '@/lib/shared/schemas/list-filters'

const log = logger.child({ component: 'invitations' })

/**
 * Get invitation details for the complete-signup page.
 * Returns invite info + whether password auth is enabled.
 *
 * Note: Uses createServerFn directly instead of withAuth because this needs to be
 * accessible to newly authenticated users who may not yet have a member record.
 */
export const getInvitationDetailsFn = createServerFn({ method: 'GET' })
  .validator(z.string())
  .handler(async ({ data: invitationId }) => {
    log.debug({ invitation_id: invitationId }, 'get invitation details: entry')

    const session = await getSession()
    if (!session?.user) {
      log.warn('get invitation details: no session')
      throw new Error('Not authenticated')
    }

    log.debug({ user_id: session.user.id }, 'get invitation details: session resolved')

    // The id comes from the invitation link. The invitation id column takes
    // only an invite TypeID, so any other value is an invitation that cannot
    // exist: answer it as not found, without a query (DEF-45).
    const [inv, settings, authConfig] = await Promise.all([
      isValidTypeId(invitationId, 'invite')
        ? db.query.invitation.findFirst({
            where: and(eq(invitation.id, invitationId as InviteId), eq(invitation.kind, 'team')),
            with: { inviter: true },
          })
        : undefined,
      db.query.settings.findFirst(),
      import('@/lib/server/domains/settings/settings.service').then((m) => m.getPublicAuthConfig()),
    ])

    if (!inv) {
      log.warn({ invitation_id: invitationId }, 'get invitation details: invitation not found')
      throw new Error(
        'This invitation could not be found. It may have been cancelled. Please contact your administrator.'
      )
    }

    log.debug(
      { invitation_id: invitationId, status: inv.status },
      'get invitation details: invitation found'
    )

    if (inv.status !== 'pending') {
      log.warn(
        { invitation_id: invitationId, status: inv.status },
        'get invitation details: invalid status'
      )
      throw new Error(
        inv.status === 'accepted'
          ? "This invitation has already been accepted. If you're having trouble accessing the dashboard, try signing in."
          : 'This invitation has been cancelled. Please ask your administrator to send a new one.'
      )
    }

    if (new Date(inv.expiresAt) < new Date()) {
      log.warn({ invitation_id: invitationId }, 'get invitation details: invitation expired')
      throw new Error('This invitation has expired. Please ask your administrator to resend it.')
    }

    // Verify the authenticated user's email matches the invitation
    if (inv.email.toLowerCase() !== session.user.email?.toLowerCase()) {
      log.warn(
        { invitation_id: invitationId, user_id: session.user.id },
        'get invitation details: email mismatch'
      )
      throw new Error(
        'This invitation was sent to a different email address. Please sign in with the email address that received the invitation, or ask your administrator to send a new invitation to your current email.'
      )
    }

    // If the user existed before this invitation, they already have an auth method —
    // skip password setup entirely (it's just a role upgrade).
    // For new users created by the magic link, offer optional password setup.
    const isExistingUser = new Date(session.user.createdAt) < inv.createdAt
    const passwordEnabled = !isExistingUser && (authConfig.oauth.password ?? true)

    log.debug(
      {
        invitation_id: invitationId,
        password_enabled: passwordEnabled,
        is_existing_user: isExistingUser,
      },
      'get invitation details: ok'
    )

    return {
      invite: {
        name: inv.name,
        email: inv.email,
        role: inv.role,
        workspaceName: settings?.name ?? 'Quackback',
        inviterName: inv.inviter?.name ?? null,
      },
      passwordEnabled,
    }
  })

const acceptInvitationSchema = z.object({
  // Only an invite TypeID can name an invitation (DEF-45).
  invitationId: filterId('invite'),
  name: z.string().min(2).optional(),
})

/**
 * Accept a team invitation.
 *
 * This server function replaces Better Auth's organization plugin acceptInvitation.
 * It validates the invitation, creates/updates the member record, and marks the
 * invitation as accepted.
 *
 * Note: Uses createServerFn directly instead of withAuth because this needs to be
 * accessible to newly authenticated users who may not yet have a member record.
 */
export const acceptInvitationFn = createServerFn({ method: 'POST' })
  .validator(acceptInvitationSchema)
  .handler(async ({ data }) => {
    const { invitationId, name } = data
    log.debug({ invitation_id: invitationId }, 'accept invitation: entry')
    // Track whether we successfully claimed the invitation so the catch
    // block only rolls back when we actually changed its status.
    let didClaim = false
    try {
      // Get current session
      const session = await getSession()
      if (!session?.user) {
        log.warn('accept invitation: no session')
        throw new Error('Your session has expired. Please sign in again using the invitation link.')
      }

      const userId = session.user.id as UserId
      const userEmail = session.user.email?.toLowerCase()
      log.debug({ user_id: userId }, 'accept invitation: session resolved')

      if (!userEmail) {
        throw new Error(
          'Your account is missing an email address. Please contact your administrator.'
        )
      }

      // Atomically claim the invitation with a conditional update to prevent
      // double-accept race conditions (e.g., double-click, network retry).
      // The `kind='team'` guard ensures portal invites cannot be consumed here.
      const [claimed] = await db
        .update(invitation)
        .set({ status: 'accepted' })
        .where(
          and(
            eq(invitation.id, invitationId as InviteId),
            eq(invitation.status, 'pending'),
            eq(invitation.kind, 'team')
          )
        )
        .returning()

      if (!claimed) {
        // Either doesn't exist, already accepted, cancelled, or expired
        const inv = await db.query.invitation.findFirst({
          where: and(eq(invitation.id, invitationId as InviteId), eq(invitation.kind, 'team')),
        })
        log.warn(
          { invitation_id: invitationId, exists: !!inv, status: inv?.status },
          'accept invitation: claim failed'
        )
        if (!inv) throw new Error('This invitation could not be found. It may have been cancelled.')
        throw new Error(
          inv.status === 'accepted'
            ? 'This invitation has already been accepted'
            : 'This invitation has been cancelled. Please ask your administrator to send a new one.'
        )
      }

      didClaim = true
      log.debug({ invitation_id: invitationId, role: claimed.role }, 'accept invitation: claimed')

      async function rollbackAndThrow(message: string): Promise<never> {
        await db
          .update(invitation)
          .set({ status: 'pending' })
          .where(eq(invitation.id, invitationId as InviteId))
        throw new Error(message)
      }

      if (new Date(claimed.expiresAt) < new Date()) {
        await rollbackAndThrow(
          'This invitation has expired. Please ask your administrator to resend it.'
        )
      }

      if (claimed.email.toLowerCase() !== userEmail) {
        await rollbackAndThrow(
          'This invitation was sent to a different email address. Please sign in with the correct email.'
        )
      }

      const role = claimed.role === 'admin' ? 'admin' : 'member'
      const displayName = name?.trim() || undefined

      // Team identity rule: the invited role takes effect only for a verified
      // address at a team domain from a linked Google or GitHub account. A
      // magic-link session alone does not qualify, so the invitation stays
      // pending and applies automatically at the next Google or GitHub
      // sign-in with this address (team-designation.ts).
      const { loadTeamIdentity, teamIdentityGap } =
        await import('@/lib/server/domains/principals/team-identity')
      const identity = await loadTeamIdentity(userId)
      const gap = identity ? teamIdentityGap(identity) : 'email_missing'
      if (gap !== null) {
        const { teamIdentityRequiredMessage } =
          await import('@/lib/server/domains/principals/team-designation')
        await rollbackAndThrow(
          `${teamIdentityRequiredMessage(gap)} Sign in with Google or GitHub using ${claimed.email}; the invitation applies automatically.`
        )
      }

      // Raise the role (never lower it), or create the principal with it, in
      // one transaction under the team-role lock. The principal is read there,
      // so a role another writer set since this request started is the one
      // compared, and the identity rule above is checked again.
      const { setUserTeamRole } = await import('@/lib/server/domains/principals/team-designation')
      const change = await setUserTeamRole({
        userId,
        newRole: role,
        mode: 'raise',
        create: { displayName: displayName ?? null },
      })
      if (change) {
        const { cacheDel, CACHE_KEYS } = await import('@/lib/server/redis')
        await cacheDel(CACHE_KEYS.PRINCIPAL_BY_USER(userId))
      }
      // A principal this call created already carries the display name.
      if (displayName && change?.previousRole !== null) {
        await db.update(principal).set({ displayName }).where(eq(principal.userId, userId))
      }

      // Update user name if provided
      if (displayName) {
        await db.update(user).set({ name: displayName }).where(eq(user.id, userId))
      }

      // The invite is accepted — revoke every token in its set so no other
      // emailed/copied link for this invite can still sign anyone in. (The link
      // just used was already consumed by the magic-link verify; siblings from
      // resends/copies would otherwise stay live until their 30-day expiry.)
      // Best-effort: the membership is already committed, so a cleanup failure
      // here must NOT hit the outer catch and roll the accept back to pending —
      // log it and move on (the stray tokens still expire with the invite).
      try {
        const { revokeMagicLinkTokens } = await import('@/lib/server/auth/magic-link-mint')
        await revokeMagicLinkTokens(claimed.magicLinkTokens)
      } catch (revokeError) {
        log.error({ err: revokeError }, 'token revoke failed')
      }

      log.info({ invitation_id: invitationId }, 'accept invitation: accepted')
      return { invitationId: invitationId as InviteId }
    } catch (error) {
      log.error({ err: error }, 'accept invitation failed')
      // Only roll back if we actually claimed the invitation. If the error
      // came from the !claimed branch (already accepted / invalid), rolling
      // back would incorrectly reopen it to 'pending'.
      if (didClaim) {
        try {
          await db
            .update(invitation)
            .set({ status: 'pending' })
            .where(eq(invitation.id, invitationId as InviteId))
        } catch (rollbackError) {
          log.error({ err: rollbackError }, 'rollback failed')
        }
      }
      throw error
    }
  })

/**
 * Set a password for the current user via Better Auth's internal API.
 *
 * Better Auth's setPassword endpoint has no HTTP path (server-side only),
 * so we must call auth.api.setPassword() from a server function.
 */
export const setPasswordFn = createServerFn({ method: 'POST' })
  .validator(z.object({ newPassword: z.string().min(8) }))
  .handler(async ({ data }) => {
    const { auth } = await import('@/lib/server/auth')
    await auth.api.setPassword({
      body: { newPassword: data.newPassword },
      headers: getRequestHeaders(),
    })
    return { status: true }
  })

/**
 * Get workspace branding for the invite page.
 * Public - no authentication required.
 */
export const getInviteBrandingFn = createServerFn({ method: 'GET' })
  .validator(z.string())
  .handler(async ({ data: invitationId }) => {
    // A value that is not an invite TypeID names no invitation, so the page
    // gets the workspace branding without an inviter and no query runs
    // (DEF-45).
    const [settings, inv] = await Promise.all([
      db.query.settings.findFirst(),
      isValidTypeId(invitationId, 'invite')
        ? db.query.invitation
            .findFirst({
              where: and(
                eq(invitation.id, invitationId as InviteId),
                or(eq(invitation.kind, 'team'), eq(invitation.kind, 'portal'))
              ),
              with: { inviter: true },
            })
            .catch(() => null)
        : null,
    ])

    return {
      workspaceName: settings?.name ?? 'Quackback',
      logoUrl: getPublicUrlOrNull(settings?.logoKey),
      inviterName: inv?.inviter?.name ?? null,
    }
  })
