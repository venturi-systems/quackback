import { contentPreview } from './string'

/** Bound the normalized one-line inbox excerpt, before it reaches the client cache. */
export const INBOX_PREVIEW_MAX_LENGTH = 300
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function inboxContentPreview(content: string): string {
  const plain = contentPreview(content)
  if (plain.length <= INBOX_PREVIEW_MAX_LENGTH) return plain

  // Normalize before truncating, and avoid splitting emoji or combining marks.
  // The bound counts UTF-16 units so even an unusually long grapheme is bounded.
  let end = 0
  for (const { index, segment } of graphemes.segment(plain)) {
    if (index + segment.length > INBOX_PREVIEW_MAX_LENGTH) break
    end = index + segment.length
  }
  return plain.slice(0, end).trimEnd() + '...'
}
