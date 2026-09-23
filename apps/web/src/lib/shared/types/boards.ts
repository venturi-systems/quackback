/**
 * Board-related types for client use.
 *
 * Re-exported from the server domain for architectural compliance — type-only
 * imports are erased at compile time and never affect the bundle.
 */

import type { BoardWithStats } from '@/lib/server/domains/boards'

export type { BoardWithStats }

/**
 * A board as exposed to public/portal clients: the internal `access` matrix
 * (segment ids, per-action tiers, moderation rules) is stripped before
 * serialization — clients gate via the server-computed boardPermissions /
 * boardCapabilitiesForActor and never read `access` (#191).
 */
export type PublicBoardWithStats = Omit<BoardWithStats, 'access'>

/**
 * Per-board capability for the current viewer, computed on the server
 * (`buildBoardPermissions` in `lib/server/functions/portal.ts`). The optional
 * fields are absent from payloads built before they existed; readers treat a
 * missing value as false.
 */
export interface BoardViewerPermissions {
  canSubmit: boolean
  canVote: boolean
  /** The viewer's new post on this board is held for team review. */
  submitRequiresReview?: boolean
  /** An ordinary signed-in account could post on this board. */
  signedInCanSubmit?: boolean
}
