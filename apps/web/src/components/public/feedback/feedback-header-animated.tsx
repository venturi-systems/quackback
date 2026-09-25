import type { BoardId } from '@quackback/ids'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useIntl, FormattedMessage } from 'react-intl'
import { useKeyboardSubmit } from '@/lib/client/hooks/use-keyboard-submit'
import { Link, useRouter, useRouteContext } from '@tanstack/react-router'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import { PencilIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RichTextEditor } from '@/components/ui/rich-text-editor'
import { usePortalImageUpload } from '@/lib/client/hooks/use-image-upload'
import { useCreatePublicPost } from '@/lib/client/mutations/portal-posts'
import { useAuthBroadcast } from '@/lib/client/hooks/use-auth-broadcast'
import { useSimilarPosts } from '@/lib/client/hooks/use-similar-posts'
import { useEnsureAnonSession } from '@/lib/client/hooks/use-ensure-anon-session'
import { SimilarPostsCard } from '@/components/public/similar-posts-card'
import { ReducedMotionConfig } from '@/components/ui/reduced-motion-config'
import { useKeepFocusInView } from '@/components/ui/keep-focus-in-view'
import { cn } from '@/lib/shared/utils'
import {
  resolveSubmitState,
  submittableBoardIds,
} from '@/components/public/feedback/submit-permission'
import {
  COMPOSER_ANCHOR,
  useOpenedAtComposer,
} from '@/components/public/feedback/share-idea-access'
import type { BoardViewerPermissions } from '@/lib/shared/types/boards'
import type { JSONContent } from '@tiptap/react'

interface BoardOption {
  id: string
  name: string
  slug: string
}

export interface FeedbackHeaderProps {
  workspaceName: string
  boards: BoardOption[]
  defaultBoardId?: string
  /**
   * The board whose feed is showing, when the visitor filtered to one board.
   * The share-an-idea surface then answers for that board alone.
   */
  scopeBoardId?: string
  user?: { name: string | null; email: string } | null
  /**
   * Per-board capability for the current viewer, keyed by board id
   * (server-computed; composes the board's access.submit tier with the
   * workspace anonymous switch). The composer lists only boards whose
   * `canSubmit` is true and shows the review notice from
   * `submitRequiresReview`, never from the workspace-wide flag.
   */
  boardPermissions?: Record<string, BoardViewerPermissions>
  onPostCreated?: (postId: string, boardSlug: string) => void
}

/**
 * The composer, with its animations following the reduced-motion preference.
 * With motion on, its panels tween their height; useKeepFocusInView keeps
 * keyboard focus in view while they do.
 */
export function FeedbackHeaderAnimated(props: FeedbackHeaderProps) {
  return (
    <ReducedMotionConfig>
      <FeedbackComposer {...props} />
    </ReducedMotionConfig>
  )
}

function FeedbackComposer({
  boards,
  defaultBoardId,
  user,
  boardPermissions,
  onPostCreated,
}: FeedbackHeaderProps) {
  const intl = useIntl()
  const router = useRouter()
  const { session } = useRouteContext({ from: '__root__' })
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState<{
    id: string
    boardSlug: string
    pending: boolean
  } | null>(null)

  const createPost = useCreatePublicPost()
  const ensureAnonSession = useEnsureAnonSession()
  const richMediaEnabled = true

  // Identified users post as themselves; anonymous posting is handled separately.
  const isAnonymousSession = session?.user?.principalType === 'anonymous'
  const effectiveUser =
    session?.user && !isAnonymousSession
      ? { name: session.user.name, email: session.user.email }
      : user
  const canUploadImages = !isAnonymousSession && !!session?.user && richMediaEnabled

  const { upload: uploadImage } = usePortalImageUpload()

  // Listen for auth success to refetch session (no page reload)
  useAuthBroadcast({
    onSuccess: () => {
      router.invalidate()
    },
    enabled: expanded,
  })

  // Only boards this viewer can post to are offered. FeedbackHeader renders
  // this composer only when at least one exists; the others get a sign-in
  // action or a restriction note instead of a form that cannot submit.
  const postableIds = submittableBoardIds(
    boards.map((b) => b.id),
    boardPermissions
  )
  const postableBoards = boards.filter((b) => postableIds.includes(b.id))
  const initialBoardId =
    defaultBoardId && postableIds.includes(defaultBoardId) ? defaultBoardId : (postableIds[0] ?? '')

  const [selectedBoardId, setSelectedBoardId] = useState(initialBoardId)

  // Sync the selection when the page's board changes (for example a board
  // filter), keeping it on a board the viewer can post to.
  useEffect(() => {
    setSelectedBoardId(initialBoardId)
  }, [initialBoardId])

  // Returning from "Sign in to share an idea" lands on the composer anchor:
  // open the form there so the visitor continues where they started.
  const openedAtComposer = useOpenedAtComposer()
  useEffect(() => {
    if (openedAtComposer) setExpanded(true)
  }, [openedAtComposer])

  // Submit CTA follows the SELECTED board's server-computed capability (which
  // composes its access.submit tier with the workspace anonymous switch for
  // this viewer) — not the workspace-wide flag, which would advertise submit
  // on a board whose tier requires sign-in (Codex #191).
  const boardCanSubmit = boardPermissions?.[selectedBoardId]?.canSubmit ?? false
  const { canSubmit, canPostAnonymously, noAccess } = resolveSubmitState(boardCanSubmit, session)
  // Truthful before submission: shown only when the server's moderation
  // decision for this viewer and board would hold the post for review.
  const submitRequiresReview =
    boardCanSubmit && (boardPermissions?.[selectedBoardId]?.submitRequiresReview ?? false)

  const [title, setTitle] = useState('')
  const [contentJson, setContentJson] = useState<JSONContent | null>(null)
  const [contentMarkdown, setContentMarkdown] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  useKeepFocusInView(composerRef)

  // Focus title input when form expands
  useEffect(() => {
    if (expanded && titleInputRef.current) {
      requestAnimationFrame(() => {
        titleInputRef.current?.focus()
      })
    }
  }, [expanded])

  // Find similar posts as user types (for duplicate detection)
  // Searches across ALL boards to find potential duplicates
  const { posts: similarPosts } = useSimilarPosts({
    title,
    enabled: expanded,
  })

  const handleContentChange = useCallback(function (
    json: JSONContent,
    _html: string,
    markdown: string
  ): void {
    setContentJson(json)
    setContentMarkdown(markdown)
  }, [])

  async function handleSubmit() {
    setError('')

    if (!selectedBoardId) {
      setError(
        intl.formatMessage({
          id: 'portal.feedback.header.errorSelectBoard',
          defaultMessage: 'Please select a board',
        })
      )
      return
    }

    if (!title.trim()) {
      setError(
        intl.formatMessage({
          id: 'portal.feedback.header.errorAddTitle',
          defaultMessage: 'Please add a title',
        })
      )
      return
    }

    if (!canSubmit) {
      setError(
        noAccess
          ? intl.formatMessage({
              id: 'portal.feedback.header.errorNoAccess',
              defaultMessage: "You don't have access to post on this board",
            })
          : intl.formatMessage({
              id: 'portal.feedback.header.errorSignIn',
              defaultMessage: 'Please sign in to submit feedback',
            })
      )
      return
    }

    try {
      if (!effectiveUser && canPostAnonymously) {
        const ok = await ensureAnonSession()
        if (!ok) {
          setError(
            intl.formatMessage({
              id: 'portal.feedback.header.errorSession',
              defaultMessage: 'Failed to create session',
            })
          )
          return
        }
      }

      const result = await createPost.mutateAsync({
        boardId: selectedBoardId as BoardId,
        title: title.trim(),
        content: contentMarkdown,
        contentJson,
      })

      setSubmitted({
        id: result.id,
        boardSlug: result.board.slug,
        pending: result.moderationState === 'pending',
      })
      resetForm()
      setExpanded(false)
      onPostCreated?.(result.id, result.board.slug)

      toast.success(
        intl.formatMessage({
          id: 'portal.feedback.header.toastSubmitted',
          defaultMessage: 'Feedback submitted',
        }),
        {
          action: {
            label: intl.formatMessage({
              id: 'portal.feedback.header.toastView',
              defaultMessage: 'View',
            }),
            onClick: () => router.navigate({ to: `/b/${result.board.slug}/posts/${result.id}` }),
          },
        }
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : intl.formatMessage({
              id: 'portal.feedback.header.errorSubmit',
              defaultMessage: 'Failed to submit feedback',
            })
      )
    }
  }

  function resetForm() {
    setSelectedBoardId(initialBoardId)
    setTitle('')
    setContentJson(null)
    setContentMarkdown('')
    setError('')
  }

  function handleCancel() {
    resetForm()
    setExpanded(false)
  }

  const handleKeyDown = useKeyboardSubmit(handleSubmit, handleCancel)

  return (
    <motion.div
      ref={composerRef}
      id={COMPOSER_ANCHOR}
      // The title field and the editor are borderless, so the card shows the
      // v6.6 focus ring while either one has keyboard or text focus.
      className={cn(
        'bg-card border border-border rounded-lg mb-5 shadow-sm overflow-hidden',
        'has-[#feedback-title-input:focus-visible]:outline-2 has-[#feedback-title-input:focus-visible]:outline-offset-2 has-[#feedback-title-input:focus-visible]:outline-(--ds-color-interactive-focus-ring)',
        'has-[.ProseMirror-focused]:outline-2 has-[.ProseMirror-focused]:outline-offset-2 has-[.ProseMirror-focused]:outline-(--ds-color-interactive-focus-ring)'
      )}
      initial={false}
      animate={{ boxShadow: expanded ? 'var(--ds-shadow-card)' : 'none' }}
      transition={{ duration: 0.2 }}
      onKeyDown={handleKeyDown}
    >
      {submitted && (
        <div role="status" className="border-b border-border px-4 py-3 text-sm">
          <p>
            {submitted.pending
              ? intl.formatMessage({
                  id: 'portal.feedback.header.pendingReview',
                  defaultMessage:
                    'Your feedback is awaiting team review. It will appear publicly if approved.',
                })
              : intl.formatMessage({
                  id: 'portal.feedback.header.submissionSaved',
                  defaultMessage: 'Your feedback has been submitted.',
                })}
          </p>
          <Link
            to="/b/$slug/posts/$postId"
            params={{ slug: submitted.boardSlug, postId: submitted.id }}
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            <FormattedMessage
              id="portal.feedback.header.viewSubmission"
              defaultMessage="View your submission"
            />
          </Link>
        </div>
      )}
      {/* Board selector - above title when expanded */}
      <AnimatePresence>
        {expanded && postableBoards.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="flex items-center px-4 sm:px-5 pt-3 pb-1">
              <span id="feedback-board-label" className="text-xs text-muted-foreground me-1">
                <FormattedMessage
                  id="portal.feedback.header.postingTo"
                  defaultMessage="Posting to"
                />
              </span>
              <Select value={selectedBoardId} onValueChange={setSelectedBoardId}>
                <SelectTrigger
                  aria-labelledby="feedback-board-label"
                  size="xs"
                  className="border-0 bg-transparent shadow-none font-medium text-foreground hover:text-foreground/80 focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ds-color-interactive-focus-ring)"
                >
                  <SelectValue
                    placeholder={intl.formatMessage({
                      id: 'portal.feedback.header.selectBoard',
                      defaultMessage: 'Select a board',
                    })}
                  />
                </SelectTrigger>
                <SelectContent align="start">
                  {postableBoards.map((board) => (
                    <SelectItem key={board.id} value={board.id} className="text-xs py-1">
                      {board.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <label
        htmlFor="feedback-title-input"
        className="block px-4 pt-3 text-xs text-muted-foreground"
      >
        <FormattedMessage
          id="portal.feedback.header.titleLabel"
          defaultMessage="Your feedback title"
        />
      </label>
      {/* Icon + Title Row - Always visible */}
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* Icon - fades out when expanded */}
        <AnimatePresence>
          {!expanded && (
            <motion.div
              initial={false}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8, width: 0, marginRight: -12 }}
              transition={{ duration: 0.2 }}
              className="flex-shrink-0 w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center"
            >
              <PencilIcon className="w-4 h-4 text-primary" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Title input - always visible, grows when expanded */}
        <motion.input
          ref={titleInputRef}
          id="feedback-title-input"
          aria-invalid={!!error}
          aria-describedby={error ? 'feedback-submit-error' : undefined}
          type="text"
          placeholder={intl.formatMessage({
            id: 'portal.feedback.header.titlePlaceholder',
            defaultMessage: "What's your idea?",
          })}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            if (!expanded) setExpanded(true)
          }}
          onFocus={() => !expanded && setExpanded(true)}
          className="flex-1 min-h-11 bg-transparent border-0 outline-none text-foreground font-semibold placeholder:text-muted-foreground/60 placeholder:font-normal caret-primary"
          initial={false}
          animate={{
            fontSize: expanded ? '1.25rem' : '1rem',
            lineHeight: expanded ? '1.75rem' : '1.5rem',
          }}
          transition={{ duration: 0.2 }}
        />
      </div>

      {/* Expandable content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            {/* Error message */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="px-4 sm:px-5"
                >
                  <div
                    id="feedback-submit-error"
                    role="alert"
                    className="[border-radius:calc(var(--radius)*0.8)] bg-destructive/10 px-3 py-2 text-sm text-destructive mb-2"
                  >
                    {error}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Rich text editor */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, delay: 0.15 }}
              className="px-4 sm:px-5 pb-4"
            >
              <RichTextEditor
                value={contentJson || ''}
                onChange={handleContentChange}
                placeholder={intl.formatMessage({
                  id: 'portal.feedback.header.detailsPlaceholder',
                  defaultMessage: 'Add more details...',
                })}
                minHeight="150px"
                borderless
                features={{ images: canUploadImages, quackbackEmbeds: true }}
                onImageUpload={canUploadImages ? uploadImage : undefined}
              />
            </motion.div>

            {/* Similar posts card - shown above footer as pre-submit prompt */}
            <SimilarPostsCard
              posts={similarPosts}
              show={title.length >= 5}
              className="px-4 sm:px-5 pb-3"
            />

            {/* Review notice: before submission, and only when true. */}
            {submitRequiresReview && (
              <p
                id="feedback-review-note"
                className="px-4 sm:px-5 pb-3 text-sm text-muted-foreground"
              >
                <FormattedMessage
                  id="portal.feedback.header.reviewNotice"
                  defaultMessage="The team reviews posts on this board before they appear publicly."
                />
              </p>
            )}

            {/* Footer with identity and actions */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: 0.2 }}
              className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-3 border-t bg-muted/30"
            >
              {noAccess ? (
                <p className="text-sm text-muted-foreground">
                  <FormattedMessage
                    id="portal.feedback.header.noAccess"
                    defaultMessage="You don't have access to post on this board"
                  />
                </p>
              ) : effectiveUser ? (
                <p className="text-sm text-muted-foreground">
                  <FormattedMessage
                    id="portal.feedback.header.postingAs"
                    defaultMessage="Posting as"
                  />{' '}
                  <span className="font-medium text-foreground" data-text-origin="user">
                    {effectiveUser.name || effectiveUser.email}
                  </span>
                </p>
              ) : canPostAnonymously ? (
                <p className="text-sm text-muted-foreground">
                  <FormattedMessage
                    id="portal.feedback.header.postingAnonymously"
                    defaultMessage="Posting anonymously"
                  />
                </p>
              ) : (
                <span />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleCancel}
                  disabled={createPost.isPending}
                >
                  <FormattedMessage id="portal.feedback.header.cancel" defaultMessage="Cancel" />
                </Button>
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={createPost.isPending}
                  aria-describedby={submitRequiresReview ? 'feedback-review-note' : undefined}
                  className="portal-submit-button bg-[var(--portal-button-background)] text-[var(--portal-button-foreground)] hover:bg-[var(--portal-button-background)]/90"
                >
                  {createPost.isPending ? (
                    <FormattedMessage
                      id="portal.feedback.header.submitting"
                      defaultMessage="Submitting..."
                    />
                  ) : (
                    <FormattedMessage id="portal.feedback.header.submit" defaultMessage="Submit" />
                  )}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
