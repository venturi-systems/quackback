/**
 * User-related types for client use.
 *
 * Re-exported from the server domain for architectural compliance — type-only
 * imports are erased at compile time and never affect the bundle.
 */

export type {
  UserSegmentSummary,
  PortalUserListParams,
  PortalUserListItemView,
  PortalUserListResultView,
  PortalUserDetail,
  EngagedPost,
} from '@/lib/server/domains/users/user.types'
