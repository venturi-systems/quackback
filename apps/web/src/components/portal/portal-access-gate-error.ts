/**
 * Re-exports from the shared location.
 *
 * The canonical definitions live in lib/shared/types/portal-gate-error.ts so
 * both the route error boundary (components/) and unit tests (lib/) can import
 * them without triggering the no-restricted-imports rule.
 */
export type { PortalAccessGateError } from '@/lib/shared/types/portal-gate-error'
export { isValidGateError, parseGateError } from '@/lib/shared/types/portal-gate-error'
