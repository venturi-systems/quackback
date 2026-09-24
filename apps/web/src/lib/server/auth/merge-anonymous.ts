/**
 * Shared utility for merging anonymous user activity into an identified user.
 *
 * Used by:
 * - Portal auth: onLinkAccount (anonymous → sign-in to existing account)
 * - Widget identify: previousToken merge (anonymous → SDK re-identify)
 *
 * Transfers: votes, comments, posts, postSubscriptions, inAppNotifications,
 * chat conversations + messages.
 * Cleans up: anonymous principal, sessions, user record.
 */
import type { PrincipalId, UserId } from '@quackback/ids'
import {
  db,
  votes,
  comments,
  posts,
  postSubscriptions,
  inAppNotifications,
  conversations,
  chatMessages,
  principal,
  session,
  user,
  eq,
  and,
  inArray,
  sql,
} from '@/lib/server/db'

export interface MergeAnonymousParams {
  /** The anonymous principal being merged FROM */
  anonPrincipalId: PrincipalId
  /** The identified principal being merged INTO */
  targetPrincipalId: PrincipalId
  /** The anonymous user ID (for session/user cleanup) */
  anonUserId: UserId
  /** Display name of the anonymous user (for notification title fixup) */
  anonDisplayName: string
  /** Display name of the target user (for notification title fixup) */
  targetDisplayName: string
}

/**
 * The identity an anonymous user row takes on when a brand-new sign-up is
 * absorbed into it (onLinkAccount's sign-up branch in auth/index.ts).
 *
 * The verification flag is the new account's own: the sign-up method decided
 * it (a provider that verified the address, or a magic link or code sent to
 * it). It used to be hard-coded true, which marked any absorbed address
 * verified, including a password sign-up's or an address a provider reported
 * unverified. The team identity rule reads this flag, and Better Auth links a
 * later Google or GitHub sign-in on it (landing-page#2309).
 */
export function absorbedSignUpIdentity(newUser: {
  name: string
  email: string
  emailVerified?: boolean | null
}): { name: string; email: string; emailVerified: boolean; isAnonymous: false } {
  return {
    name: newUser.name,
    email: newUser.email,
    emailVerified: newUser.emailVerified === true,
    isAnonymous: false,
  }
}

/**
 * The fields the anonymous principal takes on in the same absorption: it
 * becomes a person, always as a contributor.
 *
 * An anonymous principal never exercised a team role (effectiveRole caps it),
 * but a stored admin or member can sit on one, for example from a pre-fix
 * onboarding call (lib/shared/roles.ts). Flipping `type` to 'user' alone would
 * bring that stored role to life for whoever signs up next in the anonymous
 * session, with no designation. A team role is only ever given by the
 * designation paths (team-designation.ts), so the role is reset here
 * (landing-page#2309).
 */
export function absorbedSignUpPrincipal(input: {
  newName: string | null | undefined
  anonName: string | null | undefined
  image: string | null
}): {
  type: 'user'
  role: 'user'
  displayName: string | null | undefined
  avatarUrl: string | null
} {
  return {
    type: 'user',
    role: 'user',
    displayName: input.newName || input.anonName,
    avatarUrl: input.image,
  }
}

export async function mergeAnonymousToIdentified(params: MergeAnonymousParams): Promise<void> {
  const { anonPrincipalId, targetPrincipalId, anonUserId, anonDisplayName, targetDisplayName } =
    params

  await db.transaction(async (tx) => {
    // 1. Handle vote conflicts: delete anon votes that overlap with target's existing votes
    const existingVotedPostIds = await tx
      .select({ postId: votes.postId })
      .from(votes)
      .where(eq(votes.principalId, targetPrincipalId))

    if (existingVotedPostIds.length > 0) {
      await tx.delete(votes).where(
        and(
          eq(votes.principalId, anonPrincipalId),
          inArray(
            votes.postId,
            existingVotedPostIds.map((v) => v.postId)
          )
        )
      )
    }

    // 2. Get anonymous comment IDs before transfer (for notification cleanup)
    const anonCommentIds = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.principalId, anonPrincipalId))

    // 3. Transfer votes, comments, posts, and chat history to target principal.
    // Chat rows use onDelete:'restrict', so re-pointing them here is mandatory —
    // otherwise the anon-principal delete in step 6 throws and breaks the merge.
    await Promise.all([
      tx
        .update(votes)
        .set({ principalId: targetPrincipalId })
        .where(eq(votes.principalId, anonPrincipalId)),
      tx
        .update(comments)
        .set({ principalId: targetPrincipalId })
        .where(eq(comments.principalId, anonPrincipalId)),
      tx
        .update(posts)
        .set({ principalId: targetPrincipalId })
        .where(eq(posts.principalId, anonPrincipalId)),
      tx
        .update(conversations)
        .set({ visitorPrincipalId: targetPrincipalId })
        .where(eq(conversations.visitorPrincipalId, anonPrincipalId)),
      tx
        .update(chatMessages)
        .set({ principalId: targetPrincipalId })
        .where(eq(chatMessages.principalId, anonPrincipalId)),
    ])

    // 4. Fix notifications for transferred comments
    if (anonCommentIds.length > 0) {
      const commentIds = anonCommentIds.map((c) => c.id)

      // Delete self-notifications (recipient = target principal, about anonymous comments)
      await tx
        .delete(inAppNotifications)
        .where(
          and(
            eq(inAppNotifications.principalId, targetPrincipalId),
            inArray(inAppNotifications.commentId, commentIds)
          )
        )

      // Update remaining notification titles: replace anonymous name with real name
      const displayName = anonDisplayName || 'Anonymous'
      await tx
        .update(inAppNotifications)
        .set({
          title: sql`REPLACE(${inAppNotifications.title}, ${displayName}, ${targetDisplayName})`,
        })
        .where(inArray(inAppNotifications.commentId, commentIds))
    }

    // 5. Handle subscription conflicts and transfer
    const existingSubPostIds = await tx
      .select({ postId: postSubscriptions.postId })
      .from(postSubscriptions)
      .where(eq(postSubscriptions.principalId, targetPrincipalId))

    if (existingSubPostIds.length > 0) {
      await tx.delete(postSubscriptions).where(
        and(
          eq(postSubscriptions.principalId, anonPrincipalId),
          inArray(
            postSubscriptions.postId,
            existingSubPostIds.map((s) => s.postId)
          )
        )
      )
    }

    // Transfer remaining subscriptions and notifications
    await Promise.all([
      tx
        .update(postSubscriptions)
        .set({ principalId: targetPrincipalId })
        .where(eq(postSubscriptions.principalId, anonPrincipalId)),
      tx
        .update(inAppNotifications)
        .set({ principalId: targetPrincipalId })
        .where(eq(inAppNotifications.principalId, anonPrincipalId)),
    ])

    // 6. Clean up anonymous records: principal first, then sessions and user
    await tx.delete(principal).where(eq(principal.id, anonPrincipalId))
    await Promise.all([
      tx.delete(session).where(eq(session.userId, anonUserId)),
      tx.delete(user).where(eq(user.id, anonUserId)),
    ])
  })
}
