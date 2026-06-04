/**
 * Rolling-window policy for widget anonymous sessions, kept as a pure module so
 * the "when to extend" decision is unit-tested directly (the raw session-table
 * UPDATE that acts on it lives in getWidgetSession).
 *
 * Pure-Bearer widget sessions never go through Better Auth's session middleware,
 * so its `updateAge` rolling window never fires for them — they would hard-expire
 * 7 days after first mint even for an actively-returning visitor. The widget's
 * validation-only `/api/widget/session` endpoint extends the session on use,
 * mirroring Better Auth's own 24h `updateAge` cadence so we don't write on every
 * reload.
 */
export const WIDGET_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_UPDATE_AGE_MS = 24 * 60 * 60 * 1000

/** True when an active session's expiry should be rolled forward (≥24h since last touch). */
export function shouldRollSession(updatedAt: Date | null, now: number): boolean {
  if (!updatedAt) return true
  return now - updatedAt.getTime() >= SESSION_UPDATE_AGE_MS
}
