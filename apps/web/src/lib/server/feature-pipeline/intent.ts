import { db, sql, type Transaction } from '@/lib/server/db'
import { toUuid, type PostId, type BoardId, type TagId, type PrincipalId } from '@quackback/ids'
import { getBaseUrl } from '@/lib/server/config'
import { buildPostUrl } from '@/lib/server/integrations/message-utils'
import { snapshotHash, type RequestSnapshot } from './model'

import { classifyOrigin, type RequestOrigin } from './origin'

export async function recordFeatureIntent(
  tx: Transaction,
  post: {
    id: PostId
    boardId: BoardId
    title: string
    content: string
    createdAt: Date
    principalId: PrincipalId
  },
  input: {
    boardSlug: string
    tagIds: TagId[]
    author: string
    callerIsStaff: boolean
    declaredOrigin?: RequestOrigin
    originEvidence?: string
  }
) {
  const routes = await tx.execute(sql`SELECT c.*, t.name AS label
    FROM feature_pipeline_boards b
    JOIN feature_pipeline_capabilities c ON c.enabled
    JOIN tags t ON t.id=c.tag_id AND t.deleted_at IS NULL
    WHERE b.board_id=${toUuid(post.boardId)}::uuid AND b.enabled
      AND c.tag_id=ANY(ARRAY[${sql.join(
        input.tagIds.map((id) => sql`${toUuid(id)}`),
        sql`, `
      )}]::uuid[])`)
  if (routes.length === 0) return
  if (routes.length !== 1) throw new Error('Choose exactly one primary capability')
  const route = routes[0]
  const principals = await tx.execute(
    sql`SELECT role,type,display_name FROM principal WHERE id=${toUuid(post.principalId)}::uuid`
  )
  if (!principals[0]) throw new Error('Request author does not exist')
  const origin = classifyOrigin({
    authorRole: String(principals[0].role),
    authorType: String(principals[0].type),
    callerIsStaff: input.callerIsStaff,
    declaredOrigin: input.declaredOrigin,
    evidence: input.originEvidence,
  })
  const classification = origin.classification
  const snapshot: RequestSnapshot = {
    title: post.title,
    content: post.content,
    createdAt: post.createdAt.toISOString(),
    portalUrl: buildPostUrl(getBaseUrl(), input.boardSlug, post.id),
    author: String(principals[0].display_name ?? input.author),
    capability: String(route.label),
    classification,
    originEvidence: origin.evidence,
  }
  const serialized = JSON.stringify(snapshot)
  const hash = snapshotHash(snapshot)
  await tx.execute(sql`INSERT INTO feature_pipeline_links
    (post_id,capability_id,taxonomy_version,repository,repository_id,classification,
     source_snapshot,source_sha256)
    VALUES (${toUuid(post.id)}::uuid,${route.id},${route.taxonomy_version},
      ${route.repository},${route.repository_id},${classification},
      ${serialized}::jsonb,${hash}) ON CONFLICT(post_id) DO NOTHING`)
}

/** The captured per-post decision survives later board activation changes. */
export async function hasFeatureIntent(postId: PostId): Promise<boolean> {
  const rows = await db.execute(sql`SELECT 1 FROM feature_pipeline_links
    WHERE post_id=${toUuid(postId)}::uuid`)
  return rows.length > 0
}
