import { createFileRoute } from '@tanstack/react-router'
import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import { apiKeyAuditSource, recordContentAudit } from '@/lib/server/audit/content-audit'
import { noContentResponse, handleDomainError } from '@/lib/server/domains/api/responses'
import { parseTypeId } from '@/lib/server/domains/api/validation'
import type { RoadmapId, PostId } from '@quackback/ids'

export const Route = createFileRoute('/api/v1/roadmaps/$roadmapId/posts/$postId')({
  server: {
    handlers: {
      /**
       * DELETE /api/v1/roadmaps/:roadmapId/posts/:postId
       * Remove a post from a roadmap
       */
      DELETE: async ({ request, params }) => {
        try {
          const auth = await withApiKeyAuth(request, { role: 'team' })

          const roadmapId = parseTypeId<RoadmapId>(params.roadmapId, 'roadmap', 'roadmap ID')
          const postId = parseTypeId<PostId>(params.postId, 'post', 'post ID')

          const { removePostFromRoadmap } =
            await import('@/lib/server/domains/roadmaps/roadmap.service')

          await removePostFromRoadmap(postId, roadmapId)
          await recordContentAudit(apiKeyAuditSource(auth, request.headers), {
            event: 'roadmap.post.removed',
            target: { type: 'roadmap', id: roadmapId },
            before: { postId },
          })

          return noContentResponse()
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
