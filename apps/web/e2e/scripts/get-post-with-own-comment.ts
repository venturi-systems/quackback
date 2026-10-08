/**
 * Read an existing public post with the authenticated admin's own root comment.
 * Card comment counts are denormalized and the seed does not populate them.
 *
 * The post page shows a Related section only when the similar-posts search
 * (findSimilarPostsFn) finds another visible post. Its full-text half matches
 * `plainto_tsquery('english', title)`, and the seed suffixes every title after
 * the first 60 with ` (k)`, which that query keeps as a required lexeme. A
 * suffixed post therefore matches only itself and has no Related section, and
 * which posts carry the user's comments is random per seed. `has_related`
 * applies the same match to published posts on anonymously visible boards, a
 * subset of what any viewer sees, and posts that have one are preferred.
 *
 * Usage: bun get-post-with-own-comment.ts <email>
 */
import postgres from 'postgres'
import { fromUuid } from '@quackback/ids'

const email = process.argv[2]
const connectionString = process.env.DATABASE_URL
if (!email || !connectionString) {
  console.error('Email argument and DATABASE_URL environment variable are required')
  process.exit(1)
}

const sql = postgres(connectionString)

try {
  const rows = await sql`
    SELECT
      p.id AS post_id,
      b.slug AS board_slug,
      c.id AS comment_id,
      EXISTS (
        SELECT 1
        FROM posts s
        JOIN boards sb ON sb.id = s.board_id
        WHERE s.id <> p.id
          AND s.deleted_at IS NULL
          AND s.canonical_post_id IS NULL
          AND s.moderation_state = 'published'
          AND sb.deleted_at IS NULL
          AND sb.access->>'view' = 'anonymous'
          AND s.search_vector @@ plainto_tsquery('english', p.title)
      ) AS has_related
    FROM posts p
    JOIN boards b ON b.id = p.board_id
    JOIN comments c ON c.post_id = p.id
    JOIN principal author ON author.id = c.principal_id
    JOIN "user" u ON u.id = author.user_id
    WHERE u.email = ${email}
      AND b.deleted_at IS NULL
      AND b.access->>'view' = 'anonymous'
      AND b.access->>'comment' = 'anonymous'
      AND p.deleted_at IS NULL
      AND p.moderation_state = 'published'
      AND p.canonical_post_id IS NULL
      AND p.is_comments_locked = false
      AND c.parent_id IS NULL
      AND c.deleted_at IS NULL
      AND c.is_private = false
      AND c.moderation_state = 'published'
    ORDER BY has_related DESC, p.id ASC, c.id ASC
    LIMIT 1
  `
  if (rows.length === 0) {
    throw new Error('No public post with an own visible root comment exists in the E2E seed')
  }

  // Use the same UUID-to-TypeID encoder as the application route and DOM IDs.
  const postId = fromUuid('post', rows[0].post_id as string)
  const commentId = fromUuid('comment', rows[0].comment_id as string)
  const boardSlug = encodeURIComponent(rows[0].board_slug as string)
  const hasRelated = rows[0].has_related === true
  console.log(JSON.stringify({ path: `/b/${boardSlug}/posts/${postId}`, commentId, hasRelated }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await sql.end()
}
