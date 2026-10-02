import { ValidationError } from '@/lib/shared/errors'

export type RequestOrigin = 'external' | 'internal'
/** The author is the person who asked, not necessarily the authenticated recorder. */
export function classifyOrigin(input: {
  authorRole: string
  authorType: string
  callerIsStaff: boolean
  declaredOrigin?: RequestOrigin
  evidence?: string
}) {
  if (input.declaredOrigin && !input.callerIsStaff) {
    throw new ValidationError('VALIDATION_ERROR', 'Only staff may attest request origin')
  }
  const externalAuthor = input.authorRole === 'user' && input.authorType !== 'service'
  const external = externalAuthor || input.declaredOrigin === 'external'
  const evidence = input.evidence?.trim()
  if (
    input.declaredOrigin === 'external' &&
    !externalAuthor &&
    (!evidence || evidence.length < 8)
  ) {
    throw new ValidationError(
      'VALIDATION_ERROR',
      'Describe the customer or external request source'
    )
  }
  return {
    classification: external ? ('feature request' as const) : ('enhancement' as const),
    evidence:
      evidence ||
      (externalAuthor
        ? 'Submitted by or recorded on behalf of a portal customer.'
        : 'Internal team or service proposal; no external origin attested.'),
  }
}
