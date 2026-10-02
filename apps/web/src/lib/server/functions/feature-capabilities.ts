import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { filterId } from '@/lib/shared/schemas/list-filters'
import { resolvePortalAccessForRequest } from './portal-access'
import { requireAuth, policyActorFromAuth } from './auth-helpers'
import { getPublicBoardById } from '@/lib/server/domains/boards/board.public'
import { semanticOptions } from '@/lib/server/feature-pipeline/semantic-tags'
import { isTeamMember } from '@/lib/shared/roles'

export const getFeatureCapabilitiesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: filterId('board') }))
  .handler(async ({ data }) => {
    const access = await resolvePortalAccessForRequest()
    if (!access.granted) throw new Error('Portal access required')
    const ctx = await requireAuth()
    const actor = await policyActorFromAuth(ctx)
    const board = await getPublicBoardById(data.boardId as import('@quackback/ids').BoardId, actor)
    if (!board) throw new Error('Board not found')
    return semanticOptions(board.id, isTeamMember(actor.role))
  })
