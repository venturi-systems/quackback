/**
 * The reviewed resolution of each authored-text review item the render lane
 * reports (REQ-32, venturi-systems/landing-page#2309).
 *
 * The design suite checker answers NEEDS_REVIEW, not FAIL, for authored text
 * whose lines break badly only under the WCAG 1.4.12 text-spacing stress:
 * there, legibility, reflow and the full content take precedence over line
 * balance. Each such item still needs its own resolution, recorded here after
 * its render was inspected. summarize.ts prints the resolution beside the item
 * in the job summary, and keyboard-walk.spec.ts writes it into the
 * spacing-review evidence it captures (review/<route>__<width>__spacing.json).
 *
 * A resolution covers exactly the routes, text and widths it names. Another
 * width, changed text or a new element is listed with no resolution, so a
 * change to what renders is reviewed again instead of inheriting a verdict.
 * User-generated text (data-text-origin="user") is not resolved here: the
 * suite's own disposition for it is to keep the words as written.
 *
 * Inspected renders: run 36157989437 (quackback #185 head aee8a132c), the
 * spacing-review captures of each route and width named below, and the same
 * captures on the pull request that added this file; for the sidebar boards,
 * also the captures and checker reports of main runs 36199565665 and
 * 36202612458 (c262d3ea4).
 *
 * A resolution must hold for every run, not only the inspected one. The seed
 * gives each board a different post count on each run, and the count's width
 * decides whether a board name wraps, so the board resolutions say nothing
 * that depends on one run's count. keyboard-walk.spec.ts stamps a resolution
 * on its capture before the checker runs, so the capture cannot know whether
 * the checker flagged that width; summary.md's text-spacing capture table
 * says whether it did.
 */
export interface ReviewResolution {
  routes: readonly string[]
  /** The checker's text for the element. Seeded post counts differ per run. */
  text: RegExp
  /** Widths in the summary's notation: `1024s` is 1024px with text spacing. */
  widths: readonly string[]
  /** What the inspected render shows, and why that is the right outcome. */
  resolution: string
}

const FEEDS = ['admin-feed', 'anonymous-feed'] as const
const SIDEBAR_WIDTHS = ['1024s', '1440s', '1920s', '2560s'] as const

export const REVIEW_RESOLUTIONS: readonly ReviewResolution[] = [
  {
    routes: FEEDS,
    text: /^Feature Requests \d+$/,
    widths: SIDEBAR_WIDTHS,
    resolution:
      'Accepted as text-spacing reflow. The 222px sidebar button sets the post count apart at its right edge, and whether the name fits beside it depends on the width of that run\'s seeded count. On main run 36202612458 "Feature Requests 114" stayed on one line in a 44px button and the checker did not flag it; on main run 36199565665 "Feature Requests 125" wrapped to "Feature" and "Requests" in a 54px button. Wrapped or not, every word and the count are whole and legible, and nothing clips or overlaps. When it wraps, the isolated final word is the second word of a two-word name in a narrow column, and keeping it on one line would need nowrap or smaller type. The name and count used to run together in the text ("Feature Requests127" on run 36102540996); a space now separates them, and screen readers hear the name, then the count followed by "posts".',
  },
  {
    routes: FEEDS,
    text: /^General Feedback \d+$/,
    widths: SIDEBAR_WIDTHS,
    resolution:
      'Accepted as text-spacing reflow. The 222px sidebar button sets the post count apart at its right edge, and whether the name fits beside it depends on the width of that run\'s seeded count. On main runs 36199565665 ("General Feedback 112") and 36202612458 ("General Feedback 125") it wrapped to "General" and "Feedback" in a 54px button, with every word and the count whole and legible and nothing clipped or overlapping. The isolated final word is the second word of a two-word name in a narrow column, and keeping it on one line would need nowrap or smaller type. The name and count used to run together in the text ("General Feedback117" on run 36102540996); a space now separates them, and screen readers hear the name, then the count followed by "posts".',
  },
  {
    routes: ['admin-post'],
    text: /^Internal note \(team only\)$/,
    widths: ['320s'],
    resolution:
      'Accepted as text-spacing reflow. The comment form\'s note toggle is 204px wide at 320px; its centred label wraps to "Internal note (team" and "only)" beside the lock icon. The whole label is legible, the toggle stays at least 44px tall and nothing clips. There is no width for one line under the stress, and nowrap or smaller type is not allowed.',
  },
  {
    routes: ['admin-settings-statuses'],
    text: /^Toggle statuses to show on your roadmap$/,
    widths: ['320s'],
    resolution:
      'Accepted as text-spacing reflow. The description beside the "3 selected" control is 162px wide at 320px and wraps to "Toggle statuses to", "show on your" and "roadmap". It is whole, legible and clear of the control; the single final word comes from the narrow column, not a stranded fragment of a longer sentence.',
  },
  {
    routes: ['member-admin-only-notice'],
    text: /^Administrators only$/,
    widths: ['320s'],
    resolution:
      'Accepted as text-spacing reflow. The notice heading is 206px wide beside its lock icon at 320px; with letters spaced 0.12em, "Administrators" alone fills most of the line, so the heading wraps to "Administrators" and "only". Both words are whole and legible and nothing clips.',
  },
  {
    routes: ['member-admin-only-notice'],
    text: /^Only administrators can change workspace settings such as members, sign-in, portal access, branding, boards and integrations\.$/,
    widths: ['320s'],
    resolution:
      'Accepted as text-spacing reflow. The notice\'s first paragraph is 206px wide at 320px and wraps to seven lines, the last being "integrations."; every word is whole and legible, the paragraph keeps its 2em spacing before the next one, and nothing clips. The notice keeps its wording: moving one word for a break that appears only under the stress would change it.',
  },
]

/** The resolution that covers this route, text and width, if one was recorded. */
export function resolutionFor(
  route: string,
  text: string,
  width: string
): ReviewResolution | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return REVIEW_RESOLUTIONS.find(
    (entry) =>
      entry.routes.includes(route) && entry.text.test(normalized) && entry.widths.includes(width)
  )
}
