import slugifyLib from 'slugify'
import { transliterate } from 'transliteration'

/**
 * Generate a URL-friendly slug from text.
 *
 * Transliterates to ASCII first so non-Latin scripts survive as readable
 * romanizations — CJK via pinyin/romaji/romaja (反馈 -> "fan-kui"), plus
 * Cyrillic, Greek, etc. — then runs the strict slugifier for consistent
 * casing/separator handling. Returns '' for input that romanizes to nothing
 * (emoji- or punctuation-only); callers that need a guaranteed-present slug
 * supply their own fallback.
 */
export function slugify(text: string): string {
  // Guard nullish input: transliterate() coerces via String(), which would
  // otherwise turn undefined/null into the literal slug "undefined"/"null".
  if (!text) return ''
  return slugifyLib(transliterate(text), { lower: true, strict: true })
}
