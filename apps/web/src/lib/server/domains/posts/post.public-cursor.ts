import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isValidTypeId, type PostId } from '@quackback/ids'
import { ValidationError } from '@/lib/shared/errors'

interface CursorFilters {
  boardSlug?: string
  search?: string
  statusIds?: string[]
  statusSlugs?: string[]
  tagIds?: string[]
  minVotes?: number
  dateFrom?: string
  responded?: string
  limit?: number
}

const cursorSchema = z
  .object({
    version: z.literal(1),
    sort: z.literal('new'),
    createdAt: z
      .string()
      .datetime({ precision: 6 })
      .refine((timestamp) => !timestamp.startsWith('0000-'), 'PostgreSQL has no AD year zero'),
    id: z.string().refine((id) => isValidTypeId(id, 'post')),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

function filterScope(filters: CursorFilters): string {
  const sorted = (values?: string[]) => [...new Set(values ?? [])].sort()
  return createHash('sha256')
    .update(
      JSON.stringify({
        board: filters.boardSlug || null,
        search: filters.search || null,
        status: filters.statusSlugs?.length
          ? { slugs: sorted(filters.statusSlugs) }
          : { ids: sorted(filters.statusIds) },
        tags: sorted(filters.tagIds),
        minVotes: filters.minVotes && filters.minVotes > 0 ? filters.minVotes : null,
        dateFrom: filters.dateFrom ?? null,
        responded: filters.responded ?? null,
        limit: filters.limit ?? 20,
      })
    )
    .digest('hex')
}

/** Keep the exact database timestamp string; never round it through Date. */
export function encodePublicPostCursor(
  post: { id: PostId; cursorCreatedAt: string },
  filters: CursorFilters
): string {
  const payload = cursorSchema.parse({
    version: 1,
    sort: 'new',
    createdAt: post.cursorCreatedAt,
    id: post.id,
    scope: filterScope(filters),
  })
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodePublicPostCursor(cursor: string, filters: CursorFilters) {
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error('Invalid cursor encoding')
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) throw new Error('Non-canonical cursor encoding')
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const payload = cursorSchema.parse(JSON.parse(json))
    if (payload.scope !== filterScope(filters)) throw new Error('Cursor filters changed')
    return { id: payload.id as PostId, createdAt: payload.createdAt }
  } catch (error) {
    throw new ValidationError(
      'INVALID_CURSOR',
      'Invalid newest-post cursor; reload the feed.',
      error
    )
  }
}
