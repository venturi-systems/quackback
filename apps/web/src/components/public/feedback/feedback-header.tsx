import { lazy, Suspense } from 'react'
import { useIntl } from 'react-intl'
import { useRouteContext } from '@tanstack/react-router'
import { PencilIcon } from '@heroicons/react/24/solid'
import type { FeedbackHeaderProps } from './feedback-header-animated'
import { resolveComposerMode } from './submit-permission'
import { ShareIdeaSignIn, ShareIdeaUnavailable } from './share-idea-access'

// Defer framer-motion (~360KB minified) to a client-only chunk. The portal
// header is interactive — it expands on focus/click — so SSR only needs a
// static collapsed shell that matches the animated version's layout.
const FeedbackHeaderAnimated = lazy(() =>
  import('./feedback-header-animated').then((m) => ({ default: m.FeedbackHeaderAnimated }))
)

function FeedbackHeaderFallback() {
  const intl = useIntl()
  return (
    <div className="bg-card border border-border rounded-lg mb-5 shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
          <PencilIcon className="w-4 h-4 text-primary" aria-hidden />
        </div>
        <input
          type="text"
          placeholder={intl.formatMessage({
            id: 'portal.feedback.header.titlePlaceholder',
            defaultMessage: "What's your idea?",
          })}
          readOnly
          aria-label={intl.formatMessage({
            id: 'portal.feedback.header.titleLabel',
            defaultMessage: 'Your feedback title',
          })}
          aria-busy="true"
          className="flex-1 bg-transparent border-0 outline-none text-foreground font-semibold placeholder:text-muted-foreground/60 placeholder:font-normal"
        />
      </div>
    </div>
  )
}

/**
 * The feed's share-an-idea surface. The decision runs here, outside the lazy
 * composer, so server rendering already shows the right surface: an editable
 * composer only when the viewer can post somewhere; otherwise one sign-in
 * action (when signing in would allow posting) or a plain statement that
 * posting is restricted. A form whose Submit can never work is not offered.
 */
export function FeedbackHeader(props: FeedbackHeaderProps) {
  const { session } = useRouteContext({ from: '__root__' })
  const boardIds = props.boards.map((b) => b.id)
  // On one board's feed the surface answers for that board: a visitor who may
  // post elsewhere but not here is told what posting here needs, instead of
  // getting a composer that quietly targets a different board.
  const scoped = !!props.scopeBoardId && boardIds.includes(props.scopeBoardId)
  const mode = resolveComposerMode(
    scoped ? [props.scopeBoardId as string] : boardIds,
    props.boardPermissions,
    session
  )
  if (mode === 'sign-in') return <ShareIdeaSignIn />
  if (mode === 'no-access') {
    const signedIn = !!session?.user && session.user.principalType !== 'anonymous'
    return <ShareIdeaUnavailable signedIn={signedIn} singleBoard={scoped} />
  }
  return (
    <Suspense fallback={<FeedbackHeaderFallback />}>
      <FeedbackHeaderAnimated {...props} />
    </Suspense>
  )
}
