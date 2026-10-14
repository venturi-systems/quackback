/**
 * Create the help-center content the public help-center suite reads, or remove
 * exactly that content again.
 *
 *   bun set-help-center-content.ts <create|remove>
 *
 * `db:seed` creates no help-center categories or articles, so without this
 * fixture every category, article, table-of-contents and feedback test in
 * e2e/tests/public/help-center.spec.ts skips: the landing page lists only
 * categories that hold a published article.
 *
 * Every row carries the `e2e-hc-` slug prefix. `create` first deletes rows left
 * by an earlier attempt, so a retried beforeAll starts from the same state, and
 * `remove` deletes those rows and nothing else (article feedback goes with its
 * article through ON DELETE CASCADE). The two categories take negative
 * positions so they list ahead of any category another spec creates; the first
 * one holds three articles, which the prev/next test needs, and every article
 * has h2 and h3 headings for the table of contents.
 */
import postgres from 'postgres'
import { generateId, toUuid } from '@quackback/ids'
import { markdownToTiptapJson } from '@/lib/server/markdown-tiptap'

const action = process.argv[2]
if (action !== 'create' && action !== 'remove') {
  throw new Error('Usage: bun set-help-center-content.ts <create|remove>')
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const sql = postgres(process.env.DATABASE_URL)

const SLUG_PREFIX = 'e2e-hc-'
const AUTHOR_EMAIL = 'demo@example.com'

interface FixtureArticle {
  slug: string
  title: string
  description: string
  markdown: string
}

interface FixtureCategory {
  slug: string
  name: string
  description: string
  position: number
  articles: FixtureArticle[]
}

const CATEGORIES: FixtureCategory[] = [
  {
    slug: `${SLUG_PREFIX}getting-started`,
    name: 'Getting Started',
    description: 'Set up your workspace and invite your team.',
    position: -2,
    articles: [
      {
        slug: `${SLUG_PREFIX}create-your-first-board`,
        title: 'Create your first board',
        description: 'Boards collect feedback on one topic.',
        markdown: [
          'Boards collect feedback on one topic, such as feature requests or bug reports.',
          '## Before you begin',
          'You need the admin role to create a board.',
          '## Create the board',
          'Open **Boards** in the admin area and choose **New board**.',
          '### Name and slug',
          'The slug becomes part of the board address, so keep it short.',
          '- Use lowercase letters',
          '- Separate words with hyphens',
        ].join('\n\n'),
      },
      {
        slug: `${SLUG_PREFIX}invite-your-team`,
        title: 'Invite your team',
        description: 'Add teammates who triage feedback.',
        markdown: [
          'Teammates can triage feedback, reply to customers and update statuses.',
          '## Send an invitation',
          'Open **Team** in the settings and enter each email address.',
          '### Choose a role',
          'Members manage feedback; admins also manage settings.',
        ].join('\n\n'),
      },
      {
        slug: `${SLUG_PREFIX}share-your-portal`,
        title: 'Share your portal',
        description: 'Point customers at the public portal.',
        markdown: [
          'Customers submit and vote on feedback in the public portal.',
          '## Copy the portal address',
          'The address is shown at the top of the portal settings page.',
        ].join('\n\n'),
      },
    ],
  },
  {
    slug: `${SLUG_PREFIX}account-and-billing`,
    name: 'Account and Billing',
    description: 'Manage your subscription and invoices.',
    position: -1,
    articles: [
      {
        slug: `${SLUG_PREFIX}update-your-billing-details`,
        title: 'Update your billing details',
        description: 'Change the card or address on invoices.',
        markdown: [
          'Billing details appear on every invoice.',
          '## Change the payment card',
          'Open **Billing** in the settings and choose **Update card**.',
        ].join('\n\n'),
      },
    ],
  },
]

async function removeFixtureRows(tx: postgres.TransactionSql): Promise<void> {
  await tx`DELETE FROM kb_articles WHERE slug LIKE ${SLUG_PREFIX + '%'}`
  await tx`DELETE FROM kb_categories WHERE slug LIKE ${SLUG_PREFIX + '%'}`
}

async function create(): Promise<void> {
  const [author] = await sql<{ id: string }[]>`
    SELECT p.id FROM principal p JOIN "user" u ON u.id = p.user_id
    WHERE u.email = ${AUTHOR_EMAIL} AND p.type = 'user'
    LIMIT 1
  `
  if (!author) throw new Error(`No principal for ${AUTHOR_EMAIL}; run db:seed first`)

  // Published a minute ago: public reads require published_at <= now().
  const publishedAt = new Date(Date.now() - 60_000)
  await sql.begin(async (tx) => {
    await removeFixtureRows(tx)
    for (const category of CATEGORIES) {
      const categoryId = toUuid(generateId('category'))
      await tx`
        INSERT INTO kb_categories (id, slug, name, description, is_public, position)
        VALUES (${categoryId}, ${category.slug}, ${category.name}, ${category.description},
          true, ${category.position})
      `
      for (const [position, article] of category.articles.entries()) {
        // tx.json() stores a jsonb object; a string cast to ::jsonb would be stored
        // as a JSON string scalar. The TipTap tree is plain JSON, so the round
        // trip only gives it the JSONValue type postgres.js asks for.
        const contentJson = JSON.parse(
          JSON.stringify(markdownToTiptapJson(article.markdown))
        ) as postgres.JSONValue
        await tx`
          INSERT INTO kb_articles (id, category_id, slug, title, description, position, content,
            content_json, principal_id, published_at)
          VALUES (${toUuid(generateId('article'))}, ${categoryId}, ${article.slug}, ${article.title},
            ${article.description}, ${position}, ${article.markdown}, ${tx.json(contentJson)},
            ${author.id}, ${publishedAt})
        `
      }
    }
  })
}

async function main() {
  try {
    if (action === 'create') await create()
    else await sql.begin((tx) => removeFixtureRows(tx))
    console.log(JSON.stringify({ action }))
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
