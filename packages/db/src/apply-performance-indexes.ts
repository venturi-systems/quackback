/**
 * Apply auxiliary PostgreSQL indexes without wrapping them in a transaction.
 *
 * CREATE INDEX CONCURRENTLY keeps tenant writes available while each index is
 * built. The command is intentionally separate from Drizzle's transactional
 * migrator; run it after schema migrations. Every statement is idempotent.
 */
import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required')
}

const sql = postgres(connectionString, { max: 1, prepare: false })

const statements = [
  {
    name: 'pg_trgm extension',
    query: 'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  },
  {
    name: 'posts cosine HNSW',
    query: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS posts_embedding_hnsw_idx
      ON posts USING hnsw (embedding vector_cosine_ops)
      WHERE embedding IS NOT NULL
    `,
  },
  {
    name: 'knowledge-base cosine HNSW',
    query: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS kb_articles_embedding_hnsw_idx
      ON kb_articles USING hnsw (embedding vector_cosine_ops)
      WHERE embedding IS NOT NULL
    `,
  },
  {
    name: 'principal display-name trigram',
    query: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS principal_display_name_trgm_idx
      ON principal USING gin (display_name gin_trgm_ops)
      WHERE display_name IS NOT NULL
    `,
  },
  {
    name: 'chat-message content trigram',
    query: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS chat_messages_content_trgm_idx
      ON chat_messages USING gin (content gin_trgm_ops)
      WHERE deleted_at IS NULL
    `,
  },
] as const

try {
  for (const statement of statements) {
    process.stdout.write(`index: applying ${statement.name}\n`)
    await sql.unsafe(statement.query)
  }

  const rows = await sql<{
    index_name: string
    is_valid: boolean
    is_ready: boolean
  }[]>`
    SELECT c.relname AS index_name, i.indisvalid AS is_valid, i.indisready AS is_ready
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname IN (
      'posts_embedding_hnsw_idx',
      'kb_articles_embedding_hnsw_idx',
      'principal_display_name_trgm_idx',
      'chat_messages_content_trgm_idx'
    )
    ORDER BY c.relname
  `

  if (rows.length !== 4 || rows.some((row) => !row.is_valid || !row.is_ready)) {
    throw new Error(`performance indexes are incomplete or invalid: ${JSON.stringify(rows)}`)
  }
  process.stdout.write('index: all four performance indexes are valid and ready\n')
} finally {
  await sql.end()
}
