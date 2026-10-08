/**
 * Read an existing public post with the authenticated admin's own root comment.
 * Card comment counts are denormalized and the seed does not populate them.
 *
 * Usage: bun get-post-with-own-comment.ts <email> [--require-related]
 */
import postgres from 'postgres'
import { fromUuid } from '@quackback/ids'

const email = process.argv[2]
// Match the application's complete-title full-text query, including numeric
// suffixes. Title families alone do not establish a distinct Related result.
const requireRelated = process.argv.includes('--require-related')
const connectionString = process.env.DATABASE_URL
if (!email || !connectionString) {
  console.error('Email argument and DATABASE_URL environment variable are required')
  process.exit(1)
}

const sql = postgres(connectionString)

try {
  const rows = await sql`
    SELECT p.id AS post_id, b.slug AS board_slug, c.id AS comment_id
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
      AND (
        ${!requireRelated}
        OR EXISTS (
          SELECT 1
          FROM posts related
          JOIN boards related_board ON related_board.id = related.board_id
          WHERE related.id <> p.id
            AND related.deleted_at IS NULL
            AND related.canonical_post_id IS NULL
            AND related.moderation_state = 'published'
            AND related_board.deleted_at IS NULL
            AND related_board.access->>'view' = 'anonymous'
            AND related.search_vector @@ plainto_tsquery('english', p.title)
        )
      )
    ORDER BY p.id ASC, c.id ASC
    LIMIT 1
  `
  if (rows.length === 0) {
    throw new Error(
      requireRelated
        ? 'E2E fixture contract: no public post has both an own visible root comment and a distinct public full-text Related match'
        : 'No public post with an own visible root comment exists in the E2E seed'
    )
  }

  // Use the same UUID-to-TypeID encoder as the application route and DOM IDs.
  const postId = fromUuid('post', rows[0].post_id as string)
  const commentId = fromUuid('comment', rows[0].comment_id as string)
  const boardSlug = encodeURIComponent(rows[0].board_slug as string)
  console.log(JSON.stringify({ path: `/b/${boardSlug}/posts/${postId}`, commentId }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await sql.end()
}
