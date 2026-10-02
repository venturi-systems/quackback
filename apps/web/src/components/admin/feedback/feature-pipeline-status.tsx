import { useQuery, useMutation } from '@tanstack/react-query'
import type { PostId } from '@quackback/ids'
import {
  getFeaturePipelineStatusFn,
  retryFeaturePipelineFn,
} from '@/lib/server/functions/feature-pipeline-status'
import { Button } from '@/components/ui/button'

export function FeaturePipelineStatus({ postId }: { postId: PostId }) {
  const status = useQuery({
    queryKey: ['feature-pipeline-status', postId],
    queryFn: () => getFeaturePipelineStatusFn({ data: { postId } }),
    refetchInterval: 30_000,
  })
  const retry = useMutation({
    mutationFn: () => retryFeaturePipelineFn({ data: { postId } }),
    onSuccess: () => {
      void status.refetch()
    },
  })
  if (status.isError)
    return (
      <p role="status" className="text-sm">
        Request synchronization status is unavailable.
      </p>
    )
  if (!status.data) return null
  const current = status.data
  return (
    <section
      aria-label="Request synchronization"
      className="rounded border p-3 my-3 space-y-2 text-sm"
    >
      <p className="font-medium">Request synchronization: {current.phase}</p>
      {current.issueUrl && (
        <a className="underline" href={current.issueUrl} target="_blank" rel="noreferrer">
          Open implementation issue
        </a>
      )}
      {current.message && <p role="status">{current.message}</p>}
      {current.delayed && (
        <p role="status">Synchronization has not been verified within five minutes.</p>
      )}
      {current.pendingEvents > 0 && (
        <p>{current.pendingEvents} status notification records await dispatch.</p>
      )}
      {current.checkedAt && <p>Last checked: {new Date(current.checkedAt).toLocaleString()}</p>}
      {current.phase !== 'historical' && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          Retry synchronization
        </Button>
      )}
      {retry.isError && <p role="status">Retry could not be queued.</p>}
    </section>
  )
}
