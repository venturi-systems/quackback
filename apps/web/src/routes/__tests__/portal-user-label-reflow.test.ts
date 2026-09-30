import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * REQ-07 (suite v6.6): a name, title or message that admins or members write is
 * shown whole on the portal. It wraps; it never ends in an ellipsis, a line
 * clamp or a forced single line. These views have no render harness, so this
 * test reads their source.
 *
 * Reviewed exception, listed per file below:
 * - line-clamp-2 in the notification bell's compact rows: an excerpt, not a
 *   label. Every row opens its post or the notifications page, and both show
 *   the text whole.
 *
 * A notification time and a help-center article description no longer need
 * one: the time keeps its width through flex layout (shrink-0 in a wrapping
 * row) and the description wraps, since nowrap and clamping are prohibited
 * v6.6 remedies.
 */
const SRC = path.resolve(__dirname, '..', '..')

const FORCED = /\b(truncate|line-clamp-\d+|text-ellipsis|whitespace-nowrap)\b/g

const VIEWS: Array<{ file: string; userText: number; reviewed: string[] }> = [
  { file: 'routes/_portal/notifications.tsx', userText: 2, reviewed: [] },
  {
    file: 'components/notifications/notification-item.tsx',
    userText: 1,
    reviewed: ['line-clamp-2'],
  },
  { file: 'routes/_portal/support.index.tsx', userText: 1, reviewed: [] },
  {
    file: 'routes/_portal/hc/categories/$categorySlug/index.tsx',
    userText: 2,
    reviewed: [],
  },
  { file: 'components/public/portal-header.tsx', userText: 0, reviewed: [] },
  { file: 'components/help-center/help-center-search.tsx', userText: 0, reviewed: [] },
  { file: 'components/help-center/help-center-category-grid.tsx', userText: 0, reviewed: [] },
  {
    file: 'routes/_portal/hc/articles/$categorySlug/$articleSlug.tsx',
    userText: 1,
    reviewed: [],
  },
]

describe('portal views show user-written text whole (REQ-07)', () => {
  for (const view of VIEWS) {
    it(`${view.file}: no ellipsis, clamp or forced line beyond the reviewed exceptions`, () => {
      const source = readFileSync(path.join(SRC, view.file), 'utf8')
      const forced = (source.match(FORCED) ?? []).sort()
      expect(forced).toEqual([...view.reviewed].sort())
      // Each piece of user-written text is marked for the design text checker.
      expect(source.match(/data-text-origin=/g) ?? []).toHaveLength(view.userText)
    })
  }
})
