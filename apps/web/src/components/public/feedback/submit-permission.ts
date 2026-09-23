/**
 * Client-side resolution of the portal submit CTA state for the selected board.
 *
 * `boardCanSubmit` is the SERVER-computed per-board capability
 * (boardCapabilitiesForActor): it composes the board's access.submit tier with
 * the workspace anonymous master switch for the current viewer. The header
 * follows it verbatim — it must NOT re-open the form from the workspace flag on
 * a board whose submit tier requires sign-in, which would advertise an action
 * the server rejects (Codex PR #191).
 */

interface SessionLike {
  user?: { principalType?: string } | null
}

export interface SubmitState {
  /** Whether the submit button is enabled for the selected board. */
  canSubmit: boolean
  /**
   * Whether the viewer would post anonymously (submit allowed, but no real
   * user session). Drives the "Posting anonymously" label and the lazy
   * anonymous-session creation on submit.
   */
  canPostAnonymously: boolean
  /**
   * Whether a signed-in (real-user) viewer is denied submission by the board's
   * tier — an authorization failure, not authentication. Drives the "You don't
   * have access to post on this board" message instead of a sign-in prompt.
   */
  noAccess: boolean
}

export function resolveSubmitState(
  boardCanSubmit: boolean,
  session: SessionLike | null | undefined
): SubmitState {
  const sessionUser = session?.user ?? null
  const isRealUser = !!sessionUser && sessionUser.principalType !== 'anonymous'
  return {
    canSubmit: boardCanSubmit,
    canPostAnonymously: boardCanSubmit && !isRealUser,
    noAccess: !boardCanSubmit && isRealUser,
  }
}

/** Per-board capability shape the resolver reads (a subset of BoardViewerPermissions). */
interface BoardPermissionLike {
  canSubmit: boolean
  signedInCanSubmit?: boolean
}

/**
 * Which share-an-idea surface the feed shows the current viewer:
 *
 * - `composer`: the viewer can post on at least one listed board.
 * - `sign-in`: a signed-out (or anonymous-session) viewer cannot post, but an
 *   ordinary signed-in account could post on at least one listed board. The
 *   feed shows one "Sign in to share an idea" action instead of an editable
 *   composer whose Submit button can never work.
 * - `no-access`: nobody the viewer could become by signing in may post here
 *   (the boards are restricted to groups or the team), or a signed-in viewer's
 *   own tier denies every board. The feed says so instead of offering a form.
 */
export type ComposerMode = 'composer' | 'sign-in' | 'no-access'

export function resolveComposerMode(
  boardIds: ReadonlyArray<string>,
  boardPermissions: Readonly<Record<string, BoardPermissionLike>> | undefined,
  session: SessionLike | null | undefined
): ComposerMode {
  const sessionUser = session?.user ?? null
  const isRealUser = !!sessionUser && sessionUser.principalType !== 'anonymous'
  const perms = boardIds.map((id) => boardPermissions?.[id])
  if (perms.some((p) => p?.canSubmit)) return 'composer'
  if (!isRealUser && perms.some((p) => p?.signedInCanSubmit)) return 'sign-in'
  return 'no-access'
}

/** Board ids the viewer can post to, in the order given. */
export function submittableBoardIds(
  boardIds: ReadonlyArray<string>,
  boardPermissions: Readonly<Record<string, BoardPermissionLike>> | undefined
): string[] {
  return boardIds.filter((id) => boardPermissions?.[id]?.canSubmit === true)
}
