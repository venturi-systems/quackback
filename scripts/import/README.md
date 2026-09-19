# Quackback Data Import

Import data from Canny, UserVoice, or CSV files into Quackback via the REST API.

## Architecture

All imports go through the Quackback REST API — no direct database access needed.

```
Source (Canny API / UserVoice CSV / Generic CSV)
         │
         ▼
    ┌─────────────┐
    │   Adapter    │  ← Source-specific: fetches/parses native format
    └─────────────┘
         │
         ▼
    ┌─────────────┐
    │ Intermediate │  ← Standardized format
    │   Format     │    (posts, comments, votes, notes, changelogs)
    └─────────────┘
         │
         ▼
    ┌─────────────┐
    │ API Importer │  ← Generic: pushes to Quackback REST API
    └─────────────┘
         │
         ▼
    Quackback API
```

## Quick Start

```bash
# Import from Canny
bun scripts/import/cli.ts canny \
  --api-key YOUR_CANNY_API_KEY \
  --quackback-url https://feedback.yourapp.com \
  --quackback-key qb_xxx \
  --verbose

# Import from UserVoice
bun scripts/import/cli.ts uservoice \
  --suggestions ~/Downloads/full-export.csv \
  --quackback-url https://feedback.yourapp.com \
  --quackback-key qb_xxx \
  --verbose

# Import from CSV
bun scripts/import/cli.ts intermediate \
  --posts data/posts.csv \
  --comments data/comments.csv \
  --board features \
  --quackback-url https://feedback.yourapp.com \
  --quackback-key qb_xxx
```

## Prerequisites

1. **Quackback API key**: Create one in **Admin → Settings → API Keys**
2. **Quackback URL**: Your instance URL (e.g., `https://feedback.yourapp.com`)
3. **Boards**: Create target boards in the admin UI before importing

You can set these as environment variables instead of CLI flags:

```bash
export QUACKBACK_URL=https://feedback.yourapp.com
export QUACKBACK_API_KEY=qb_xxx
export CANNY_API_KEY=your_canny_key  # for Canny imports
```

## CLI Reference

### Commands

| Command        | Description                        |
| -------------- | ---------------------------------- |
| `canny`        | Import from Canny via their API    |
| `uservoice`    | Import from UserVoice export files |
| `intermediate` | Import from generic CSV files      |
| `help`         | Show help message                  |

### Required Options (all commands)

| Option            | Description             | Env var             |
| ----------------- | ----------------------- | ------------------- |
| `--quackback-url` | Quackback instance URL  | `QUACKBACK_URL`     |
| `--quackback-key` | Quackback admin API key | `QUACKBACK_API_KEY` |

### Common Options

| Option      | Description                      | Default |
| ----------- | -------------------------------- | ------- |
| `--dry-run` | Validate only, don't insert data | false   |
| `--verbose` | Show detailed progress           | false   |

### Canny Options

| Option      | Description   | Env var         |
| ----------- | ------------- | --------------- |
| `--api-key` | Canny API key | `CANNY_API_KEY` |

### UserVoice Options

| Option                 | Description                            |
| ---------------------- | -------------------------------------- |
| `--suggestions <file>` | Full suggestions export CSV (required) |
| `--comments <file>`    | Comments CSV (optional)                |
| `--notes <file>`       | Internal notes CSV (optional)          |
| `--users <file>`       | Subdomain users CSV (optional)         |

### Intermediate Format Options

| Option              | Description             |
| ------------------- | ----------------------- |
| `--board <slug>`    | Target board slug       |
| `--posts <file>`    | Posts CSV file          |
| `--comments <file>` | Comments CSV file       |
| `--votes <file>`    | Votes CSV file          |
| `--notes <file>`    | Internal notes CSV file |

## Canny Import

The Canny adapter connects directly to the Canny API and fetches everything automatically.

### What gets imported

- **Boards** — mapped to Quackback boards by name
- **Posts** — titles, descriptions, statuses, images, creation dates
- **Comments** — threaded, with internal comments routed to private notes
- **Votes** — individual voter attribution via proxy voting
- **Tags & categories** — Canny categories imported as tags
- **Changelog entries** — with linked post relationships preserved
- **Merge relationships** — chains resolved and replayed (A→B→C becomes A→C)
- **Users** — collected from all entities, identified by email

### Status mapping

| Canny Status | Quackback Status |
| ------------ | ---------------- |
| open         | open             |
| under review | under_review     |
| planned      | planned          |
| in progress  | in_progress      |
| complete     | complete         |
| closed       | closed           |

### Example

```bash
# Dry run first
bun scripts/import/cli.ts canny \
  --api-key YOUR_CANNY_API_KEY \
  --quackback-url https://feedback.yourapp.com \
  --quackback-key qb_xxx \
  --dry-run --verbose

# Run the import
bun scripts/import/cli.ts canny \
  --api-key YOUR_CANNY_API_KEY \
  --quackback-url https://feedback.yourapp.com \
  --quackback-key qb_xxx \
  --verbose
```

## UserVoice Import

UserVoice provides a full denormalized export where each row represents an idea + voter relationship. The adapter deduplicates automatically.

### Export files

1. **Full suggestions export** (required): The denormalized CSV
2. **comments.csv** (optional): Public comments
3. **notes.csv** (optional): Internal staff notes
4. **users.csv** (optional): Subdomain users

### Status mapping

| UserVoice Status      | Quackback Status |
| --------------------- | ---------------- |
| active                | open             |
| under review          | under_review     |
| planned               | planned          |
| started / in progress | in_progress      |
| completed / shipped   | complete         |
| declined / closed     | closed           |

### Example

```bash
bun scripts/import/cli.ts uservoice \
  --suggestions ~/Downloads/uservoice-full-export.csv \
  --comments ~/Downloads/comments.csv \
  --notes ~/Downloads/notes.csv \
  --quackback-url https://feedback.yourapp.com \
  --quackback-key qb_xxx \
  --verbose
```

## Intermediate CSV Format

Import from any source by converting to these CSV files first.

### posts.csv

| Column         | Required | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `id`           | ✓        | External ID (for linking comments/votes) |
| `title`        | ✓        | Post title                               |
| `body`         | ✓        | Content (plain text or HTML)             |
| `author_email` |          | Author email address                     |
| `author_name`  |          | Author display name                      |
| `board`        |          | Board slug (or use `--board` flag)       |
| `status`       |          | Status slug (open, planned, etc.)        |
| `moderation`   |          | published/pending/spam/archived          |
| `tags`         |          | Comma-separated tag names                |
| `vote_count`   |          | Fallback vote count                      |
| `created_at`   |          | ISO 8601 timestamp                       |

### comments.csv

| Column         | Required | Description         |
| -------------- | -------- | ------------------- |
| `post_id`      | ✓        | External post ID    |
| `body`         | ✓        | Comment text        |
| `author_email` |          | Commenter email     |
| `author_name`  |          | Commenter name      |
| `is_staff`     |          | true if team member |
| `created_at`   |          | ISO 8601 timestamp  |

### votes.csv

| Column        | Required | Description         |
| ------------- | -------- | ------------------- |
| `post_id`     | ✓        | External post ID    |
| `voter_email` | ✓        | Voter email address |
| `created_at`  |          | ISO 8601 timestamp  |

### notes.csv

| Column         | Required | Description        |
| -------------- | -------- | ------------------ |
| `post_id`      | ✓        | External post ID   |
| `body`         | ✓        | Note content       |
| `author_email` |          | Staff email        |
| `author_name`  |          | Staff name         |
| `created_at`   |          | ISO 8601 timestamp |

## Adding New Adapters

1. Create `scripts/import/adapters/<platform>/`
2. Implement a `convert<Platform>()` function that returns `IntermediateData`
3. Add a new command to `cli.ts` that calls the adapter then `runApiImport()`

```typescript
import type { IntermediateData } from '../../schema/types'

export function convertNewPlatform(options: { /* ... */ }): {
  data: IntermediateData
  stats: {
    /* ... */
  }
} {
  // 1. Parse/fetch the platform's data
  // 2. Convert to intermediate format
  // 3. Return data and stats
}
```

## Troubleshooting

### "Board not found" / posts skipped

The target board must exist before importing. Create boards in the admin UI first, then ensure the board names or slugs in your source data match.

### Vote counts don't match source

Votes are imported as individual proxy votes per user email. If the source has more votes than voter emails in the export, the count will differ.

### Dry run first

Always validate before importing:

```bash
bun scripts/import/cli.ts canny --api-key KEY \
  --quackback-url URL --quackback-key KEY \
  --dry-run --verbose
```

## Data Safety

- Always run with `--dry-run` first to validate
- Imports are additive — existing posts are not deleted
- Duplicate votes (same user + post) are skipped
- Posts keep their original timestamps when provided
- The API importer retries on rate limits and server errors with exponential backoff
