/**
 * Picks the seeded post the render lane's post routes measure.
 *
 * The post must show every post-page surface quackback #131 changed:
 *   - it is on a public roadmap, so the post sidebar's roadmap links render;
 *   - it has a visible root comment, so the comment thread renders;
 *   - its board lets anyone read and comment, so the signed-out route shows
 *     the comment sign-in prompt.
 * Among those, a post where the administrator has a root comment is preferred,
 * so the admin route also shows the author's own comment actions.
 *
 * The seed assigns roadmaps and comments at random, so the post differs on
 * every run; the query orders by id so one run is deterministic.
 *
 * Usage (from apps/web): dotenv -e ../../.env -- bun e2e/render/find-render-post.ts <admin email>
 * Prints {"path": "/b/<board>/posts/<post id>", "ownComment": true|false}.
 */
import postgres from 'postgres'
import { fromUuid } from '@quackback/ids'

const adminEmail = process.argv[2]
const connectionString = process.env.DATABASE_URL
if (!adminEmail || !connectionString) {
  console.error('Admin email argument and DATABASE_URL environment variable are required')
  process.exit(1)
}

const sql = postgres(connectionString)

try {
  const rows = await sql`
    SELECT p.id AS post_id, b.slug AS board_slug,
      EXISTS (
        SELECT 1
        FROM comments oc
        JOIN principal author ON author.id = oc.principal_id
        JOIN "user" u ON u.id = author.user_id
        WHERE oc.post_id = p.id
          AND u.email = ${adminEmail}
          AND oc.parent_id IS NULL
          AND oc.deleted_at IS NULL
          AND oc.is_private = false
          AND oc.moderation_state = 'published'
      ) AS own_comment
    FROM posts p
    JOIN boards b ON b.id = p.board_id
    WHERE b.deleted_at IS NULL
      AND b.access->>'view' = 'anonymous'
      AND b.access->>'comment' = 'anonymous'
      AND p.deleted_at IS NULL
      AND p.moderation_state = 'published'
      AND p.canonical_post_id IS NULL
      AND p.is_comments_locked = false
      AND EXISTS (
        SELECT 1
        FROM post_roadmaps pr
        JOIN roadmaps r ON r.id = pr.roadmap_id
        WHERE pr.post_id = p.id AND r.is_public = true AND r.deleted_at IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM comments c
        WHERE c.post_id = p.id
          AND c.parent_id IS NULL
          AND c.deleted_at IS NULL
          AND c.is_private = false
          AND c.moderation_state = 'published'
      )
    ORDER BY own_comment DESC, p.id ASC
    LIMIT 1
  `
  if (rows.length === 0) {
    throw new Error(
      'No public post on a public roadmap with a visible root comment exists in the E2E seed'
    )
  }

  // Use the same UUID-to-TypeID encoder as the application route.
  const postId = fromUuid('post', rows[0].post_id as string)
  const boardSlug = encodeURIComponent(rows[0].board_slug as string)
  console.log(
    JSON.stringify({ path: `/b/${boardSlug}/posts/${postId}`, ownComment: rows[0].own_comment })
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await sql.end()
}
