import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ShieldCheckIcon } from '@heroicons/react/24/outline'
import { toast } from 'sonner'
import {
  listPendingPostsFn,
  listPendingCommentsFn,
  approvePostFn,
  rejectPostFn,
  approveCommentFn,
  rejectCommentFn,
} from '@/lib/server/functions/moderation'
import { adminQueries } from '@/lib/client/queries/admin'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/shared/spinner'
import { EmptyState } from '@/components/shared/empty-state'

export const Route = createFileRoute('/admin/moderation')({
  loader: async () => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'member'] } })
    return {}
  },
  component: ModerationPage,
})

function ModerationPage() {
  const queryClient = useQueryClient()
  const [pendingId, setPendingId] = useState<string | null>(null)

  const postsQuery = useQuery({
    queryKey: ['admin', 'moderation', 'pending', 'posts'],
    queryFn: () => listPendingPostsFn(),
  })
  const commentsQuery = useQuery({
    queryKey: ['admin', 'moderation', 'pending', 'comments'],
    queryFn: () => listPendingCommentsFn(),
  })

  const invalidateAfterDecision = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'moderation'] })
    queryClient.invalidateQueries({ queryKey: adminQueries.moderationStatus().queryKey })
  }

  const onError = () => {
    toast.error('This item was already handled -- refreshing the queue.')
    invalidateAfterDecision()
  }

  const approvePost = useMutation({
    mutationFn: (postId: string) => approvePostFn({ data: { postId } }),
    onSuccess: invalidateAfterDecision,
    onError,
    onSettled: () => setPendingId(null),
  })
  const rejectPost = useMutation({
    mutationFn: (postId: string) => rejectPostFn({ data: { postId } }),
    onSuccess: invalidateAfterDecision,
    onError,
    onSettled: () => setPendingId(null),
  })
  const approveComment = useMutation({
    mutationFn: (commentId: string) => approveCommentFn({ data: { commentId } }),
    onSuccess: invalidateAfterDecision,
    onError,
    onSettled: () => setPendingId(null),
  })
  const rejectComment = useMutation({
    mutationFn: (commentId: string) => rejectCommentFn({ data: { commentId } }),
    onSuccess: invalidateAfterDecision,
    onError,
    onSettled: () => setPendingId(null),
  })

  if (postsQuery.isLoading || commentsQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const posts = postsQuery.data?.posts ?? []
  const comments = commentsQuery.data?.comments ?? []
  const total = posts.length + comments.length

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <ShieldCheckIcon className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Moderation Queue</h1>
            <p className="text-xs text-muted-foreground">
              {total === 0
                ? 'Nothing pending'
                : `${total} item${total === 1 ? '' : 's'} awaiting review`}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        {total === 0 ? (
          <EmptyState
            icon={ShieldCheckIcon}
            title="All caught up"
            description="No submissions are awaiting review."
          />
        ) : (
          <>
            {posts.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-muted-foreground mb-3">
                  Pending posts ({posts.length})
                </h2>
                <ul className="space-y-3">
                  {posts.map((post) => (
                    <li
                      key={post.id}
                      className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{post.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          by {post.authorName ?? 'Anonymous'} in {post.boardName}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                          {post.content}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            setPendingId(post.id as string)
                            approvePost.mutate(post.id as string)
                          }}
                          disabled={pendingId === post.id}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setPendingId(post.id as string)
                            rejectPost.mutate(post.id as string)
                          }}
                          disabled={pendingId === post.id}
                        >
                          Reject
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {comments.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-muted-foreground mb-3">
                  Pending comments ({comments.length})
                </h2>
                <ul className="space-y-3">
                  {comments.map((comment) => (
                    <li
                      key={comment.id}
                      className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-muted-foreground">
                          on{' '}
                          <span className="font-medium text-foreground">{comment.postTitle}</span>{' '}
                          in {comment.boardName}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          by {comment.authorName ?? 'Anonymous'}
                        </p>
                        <p className="mt-1 text-sm text-foreground line-clamp-3">
                          {comment.content}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            setPendingId(comment.id as string)
                            approveComment.mutate(comment.id as string)
                          }}
                          disabled={pendingId === comment.id}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setPendingId(comment.id as string)
                            rejectComment.mutate(comment.id as string)
                          }}
                          disabled={pendingId === comment.id}
                        >
                          Reject
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
