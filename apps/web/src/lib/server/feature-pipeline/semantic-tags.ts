import { db, sql, type Transaction } from '@/lib/server/db'
import { fromUuid, toUuid, type BoardId, type TagId } from '@quackback/ids'
import { ValidationError } from '@/lib/shared/errors'

export interface CapabilityOption {
  id: TagId
  label: string
}
type Executor = typeof db | Transaction

export async function isGovernedFeatureBoard(boardId: BoardId, executor: Executor = db) {
  if (process.env.FEATURE_PIPELINE_ENABLED !== 'true') return false
  const rows = await executor.execute(sql`SELECT enabled FROM feature_pipeline_boards
    WHERE board_id=${toUuid(boardId)}::uuid AND enabled=true`)
  return rows.length > 0
}

/** Safe client projection: never serialize repository metadata. */
export async function semanticOptions(boardId: BoardId, staff: boolean) {
  if (!(await isGovernedFeatureBoard(boardId))) return { required: false, options: [] }
  const rows = await db.execute(sql`SELECT t.id, t.name FROM feature_pipeline_capabilities c
    JOIN tags t ON t.id=c.tag_id WHERE c.enabled AND t.deleted_at IS NULL
    AND (c.visibility='customer' OR ${staff}) ORDER BY t.name`)
  return {
    required: true,
    options: rows.map((r) => ({ id: fromUuid('tag', String(r.id)), label: String(r.name) })),
  }
}

export async function validateSemanticTags(boardId: BoardId, tagIds: TagId[], staff: boolean) {
  const { required, options } = await semanticOptions(boardId, staff)
  if (!required) return
  const allowed = new Set(options.map((o) => o.id))
  const selected = [...new Set(tagIds)].filter((id) => allowed.has(id))
  if (selected.length !== 1) {
    throw new ValidationError('VALIDATION_ERROR', 'Choose one primary capability for this request')
  }
  const ids = tagIds.map(toUuid)
  const rows = await db.execute(sql`SELECT c.tag_id FROM feature_pipeline_capabilities c
    WHERE c.tag_id = ANY(${ids}::uuid[]) AND (NOT c.enabled OR
      (c.visibility='staff' AND NOT ${staff}))`)
  if (rows.length) {
    throw new ValidationError(
      'VALIDATION_ERROR',
      'This capability is not available to your account'
    )
  }
}
