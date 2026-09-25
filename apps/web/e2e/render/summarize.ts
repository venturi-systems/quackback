/**
 * Reads every report the render lane wrote and turns it into the job summary
 * and the job's verdict.
 *
 * The job fails when:
 *   - a planned route has no checker report, or its checker crashed;
 *   - a checker report is FAIL: an applicable authored headline or short-copy
 *     failure, or an infrastructure failure (fonts, page errors, overflow,
 *     document wider than the viewport, no measurable text);
 *   - a checker run ended on another path than the planned one: a redirect,
 *     such as to sign-in when a session was not honoured, would otherwise
 *     measure the wrong page and pass;
 *   - a planned keyboard walk has no result, or its result has a finding.
 *
 * NEEDS_REVIEW is not a failure here: it is the suite's own disposition for
 * prose, user-generated text and text-spacing stress, and each one needs an
 * individual reviewed resolution, which the summary lists for that purpose.
 *
 * Writes summary.md beside the reports and appends it to $GITHUB_STEP_SUMMARY
 * when that is set. Usage (from apps/web): bun e2e/render/summarize.ts
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  CHECKER_DIR,
  KEYBOARD_DIR,
  OUT_DIR,
  PLAN_PATH,
  ROUTES,
  SUITE_DIR,
  walkContextsFor,
} from './plan'

interface CheckerFinding {
  source?: string
  width: number
  stress: boolean
  kind?: string
  selector: string | null
  profile?: string
  origin?: string
  text?: string
  status: string
  reasons?: string[]
  reviewReasons?: string[]
  lastLineRatio?: number | null
  reason?: string
}

interface CheckerRun {
  width: number
  textSpacingStress: boolean
  httpStatus: number | null
  loadedFonts: string
  fonts: { family: string; status: string }[]
  elements: { overflow: boolean; selector: string; text: string }[]
  errors: string[]
  documentWidth: number
  finalURL: string
}

interface CheckerReport {
  status: 'PASS' | 'NEEDS_REVIEW' | 'FAIL'
  policySha256: string
  toolInputs: { path: string; sha256: string }[]
  summary: {
    runs: number
    elements: number
    failures: number
    needsReview: number
    fontReviews: number
    unmeasuredText: number
    infrastructureFailures: number
  }
  runs: CheckerRun[]
  failures: CheckerFinding[]
  reviews: CheckerFinding[]
}

interface KeyboardResult {
  route: string
  identity: string
  path: string
  context: { id: string; pointer: string; minTarget: number; width: number }
  pointerCoarse: boolean | null
  forward: { end: string; stops: { visibility?: string; onScreen?: number }[] } | null
  reverse: {
    end: string
    stopCount: number
    matchesForward: boolean
    forwardOnly?: unknown[]
    reverseOnly?: unknown[]
  } | null
  findings: { kind: string; selector?: string; name?: string; detail: string; direction?: string }[]
}

const MAX_ROWS = 80

// A table cell: one line, backslashes escaped before pipes so a value can
// neither end the cell early nor turn the escape itself into a literal.
const cell = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** The path of a URL or of a path with a query; null when it cannot be parsed. */
const pathOf = (value: string): string | null => {
  try {
    return new URL(value, 'http://render.invalid').pathname
  } catch {
    return null
  }
}

const lines: string[] = []
const problems: string[] = []
const out = (line = '') => lines.push(line)

out('## Signed-in render check')
out()
const plan = readJson<{
  routes: { id: string; identity: string; path: string }[]
  generatedAt: string
}>(PLAN_PATH)
if (!plan) problems.push(`no render plan at ${PLAN_PATH}: the identities did not sign in`)

const pin = readJson<{ release: string; files: { path: string; sha256: string }[] }>(
  path.join(SUITE_DIR, 'suite-pin.json')
)
if (pin) {
  const digests = pin.files.map((file) => {
    const actual = sha256(path.join(SUITE_DIR, file.path))
    if (actual !== file.sha256) problems.push(`${file.path} does not match its pin`)
    return `\`${file.path}\` ${actual.slice(0, 12)}`
  })
  out(`Design suite ${pin.release}, unmodified (${digests.join(', ')}).`)
}
const index = readJson<{
  widths: number[]
  invocations: {
    route: string
    exitCode: number | null
    signal: string | null
    seconds: number
    reportWritten: boolean
    url: string
  }[]
}>(path.join(CHECKER_DIR, 'index.json'))
if (index) {
  out(
    `Widths from the pinned policy: ${index.widths.join(', ')} px, each as rendered and with the WCAG 1.4.12 text-spacing stress.`
  )
}
out()

// ---- Typography -------------------------------------------------------------
out('### Typography: design suite checker')
out()
out(
  '| Route | Identity | Path | Status | Runs | Elements | Failures | Review | Font review | Unmeasured | Infrastructure | Seconds |'
)
out('|---|---|---|---|---|---|---|---|---|---|---|---|')
const allFailures: (CheckerFinding & { route: string })[] = []
const allReviews: (CheckerFinding & { route: string })[] = []
const infra: string[] = []
for (const route of plan?.routes ?? []) {
  const invocation = index?.invocations.find((i) => i.route === route.id)
  const report = readJson<CheckerReport>(path.join(CHECKER_DIR, `${route.id}.json`))
  if (!report) {
    problems.push(
      `${route.id}: no checker report (exit ${invocation?.exitCode ?? invocation?.signal ?? 'not run'})`
    )
    out(
      `| ${route.id} | ${route.identity} | \`${cell(route.path)}\` | NO REPORT | | | | | | | | ${invocation?.seconds ?? ''} |`
    )
    continue
  }
  const s = report.summary
  if (report.status === 'FAIL') problems.push(`${route.id}: checker status FAIL`)
  out(
    `| ${route.id} | ${route.identity} | \`${cell(route.path)}\` | ${report.status} | ${s.runs} | ${s.elements} | ${s.failures} | ${s.needsReview} | ${s.fontReviews} | ${s.unmeasuredText} | ${s.infrastructureFailures} | ${invocation?.seconds ?? ''} |`
  )
  for (const failure of report.failures) allFailures.push({ ...failure, route: route.id })
  for (const review of report.reviews) allReviews.push({ ...review, route: route.id })
  for (const run of report.runs) {
    const reasons: string[] = []
    if (run.loadedFonts !== 'loaded') reasons.push(`fonts ${run.loadedFonts}`)
    const broken = run.fonts.filter((f) => f.status === 'error').map((f) => f.family)
    if (broken.length) reasons.push(`font errors: ${broken.join(', ')}`)
    if (!run.elements.length) reasons.push('no measurable text')
    const overflowing = run.elements.filter((e) => e.overflow)
    if (overflowing.length) {
      reasons.push(
        `overflowing text: ${overflowing
          .slice(0, 3)
          .map((e) => `${e.selector} "${e.text.slice(0, 40)}"`)
          .join('; ')}`
      )
    }
    if (run.errors.length) reasons.push(`errors: ${run.errors.slice(0, 3).join('; ')}`)
    if (run.documentWidth > run.width) reasons.push(`document ${run.documentWidth}px wide`)
    const renderedPath = pathOf(run.finalURL)
    if (renderedPath !== pathOf(route.path)) {
      const detail = `rendered ${renderedPath ?? run.finalURL}, planned ${pathOf(route.path)}`
      reasons.push(detail)
      problems.push(
        `${route.id} at ${run.width}px${run.textSpacingStress ? ' with text spacing' : ''}: ${detail}`
      )
    }
    if (reasons.length) {
      infra.push(
        `| ${route.id} | ${run.width} | ${run.textSpacingStress ? 'yes' : 'no'} | ${cell(reasons.join(' / '))} |`
      )
    }
  }
}
out()

if (allFailures.length) {
  out(`#### Failures (${allFailures.length})`)
  out()
  out('| Route | Width | Text spacing | Profile | Origin | Ratio | Selector | Text | Reason |')
  out('|---|---|---|---|---|---|---|---|---|')
  for (const f of allFailures.slice(0, MAX_ROWS)) {
    out(
      `| ${f.route} | ${f.width} | ${f.stress ? 'yes' : 'no'} | ${cell(f.profile)} | ${cell(f.origin)} | ${f.lastLineRatio ?? ''} | \`${cell(f.selector)}\` | ${cell(f.text)} | ${cell((f.reasons ?? []).join(' '))} |`
    )
  }
  if (allFailures.length > MAX_ROWS) out(`\n${allFailures.length - MAX_ROWS} more in the artifact.`)
  out()
}
if (infra.length) {
  out(`#### Infrastructure failures (${infra.length} runs)`)
  out()
  out('| Route | Width | Text spacing | Reason |')
  out('|---|---|---|---|')
  for (const row of infra.slice(0, MAX_ROWS)) out(row)
  out()
}
if (allReviews.length) {
  // Group the same element and text across widths: one reviewed resolution
  // is recorded per element, with every width it applies to.
  const groups = new Map<string, { f: CheckerFinding & { route: string }; widths: Set<string> }>()
  for (const r of allReviews) {
    const key = `${r.route}\u0000${r.kind ?? 'text'}\u0000${r.selector}\u0000${r.text ?? r.reason ?? ''}`
    const group = groups.get(key) ?? { f: r, widths: new Set<string>() }
    group.widths.add(`${r.width}${r.stress ? 's' : ''}`)
    groups.set(key, group)
  }
  out(`#### Review items (${allReviews.length} findings, ${groups.size} distinct elements)`)
  out()
  out('Widths marked `s` are the text-spacing stress run.')
  out()
  out('| Route | Kind | Profile | Origin | Selector | Text | Widths | Review reason |')
  out('|---|---|---|---|---|---|---|---|')
  for (const { f, widths } of Array.from(groups.values()).slice(0, MAX_ROWS)) {
    out(
      `| ${f.route} | ${cell(f.kind ?? 'text')} | ${cell(f.profile)} | ${cell(f.origin)} | \`${cell(f.selector)}\` | ${cell(f.text ?? '')} | ${Array.from(widths).join(' ')} | ${cell((f.reviewReasons ?? [f.reason]).join(' '))} |`
    )
  }
  if (groups.size > MAX_ROWS) out(`\n${groups.size - MAX_ROWS} more in the artifact.`)
  out()
}

// ---- Keyboard ---------------------------------------------------------------
/**
 * How the Shift+Tab walk differs from the Tab walk, by element identity: the
 * elements reached only going forward and only coming back. Evidence for
 * review, not a failure (a list that loads while the walk passes it adds
 * stops on the way back); the walk's own report names each element.
 */
const reverseDifference = (reverse: KeyboardResult['reverse']): string => {
  if (!reverse || reverse.matchesForward) return ''
  const forwardOnly = reverse.forwardOnly?.length ?? 0
  const reverseOnly = reverse.reverseOnly?.length ?? 0
  if (!forwardOnly && !reverseOnly) return ' (same elements, other order)'
  return ` (${forwardOnly} forward only, ${reverseOnly} reverse only)`
}

/**
 * Forward stops that were partly outside the viewport but at least half on
 * screen. Less than half is a finding; this much is evidence for review, and
 * the walk report gives each stop's rect and on-screen share.
 */
const partlyOffScreen = (forward: KeyboardResult['forward']): number =>
  forward?.stops.filter((stop) => stop.visibility === 'clipped' && (stop.onScreen ?? 0) >= 0.5)
    .length ?? 0

out('### Keyboard walk')
out()
out(
  'A note beside the reverse end counts the elements only one of the two walks reached, compared by element rather than by selector. It is evidence for review, not a failure; the walk report names each element.'
)
out()
out(
  'Partly off screen counts the forward stops that ran past the viewport while at least half of the element stayed on screen. Less than half on screen is a finding. The count is evidence for review; the walk report gives each stop its rect and on-screen share.'
)
out()
out(
  '| Route | Context | Coarse pointer | Stops | Forward end | Reverse end | Partly off screen | Findings |'
)
out('|---|---|---|---|---|---|---|---|')
const keyboardFindings: string[] = []
for (const route of ROUTES) {
  for (const { id: context } of walkContextsFor(route)) {
    const result = readJson<KeyboardResult>(path.join(KEYBOARD_DIR, `${route.id}__${context}.json`))
    if (!result) {
      problems.push(`${route.id} at ${context}: no keyboard walk result`)
      out(`| ${route.id} | ${context} | | | NO RESULT | | | |`)
      continue
    }
    out(
      `| ${route.id} | ${context} | ${result.pointerCoarse ?? ''} | ${result.forward?.stops.length ?? ''} | ${result.forward?.end ?? ''} | ${result.reverse?.end ?? ''}${reverseDifference(result.reverse)} | ${partlyOffScreen(result.forward)} | ${result.findings.length} |`
    )
    if (result.findings.length)
      problems.push(`${route.id} at ${context}: ${result.findings.length} keyboard findings`)
    for (const f of result.findings) {
      keyboardFindings.push(
        `| ${route.id} | ${context} | ${f.kind} | ${cell(f.direction)} | \`${cell(f.selector)}\` | ${cell(f.name)} | ${cell(f.detail)} |`
      )
    }
  }
}
out()
if (keyboardFindings.length) {
  out(`#### Keyboard findings (${keyboardFindings.length})`)
  out()
  out('| Route | Context | Kind | Direction | Selector | Name | Detail |')
  out('|---|---|---|---|---|---|---|')
  for (const row of keyboardFindings.slice(0, MAX_ROWS)) out(row)
  if (keyboardFindings.length > MAX_ROWS)
    out(`\n${keyboardFindings.length - MAX_ROWS} more in the artifact.`)
  out()
}

out('### Verdict')
out()
if (problems.length) {
  out(`FAIL (${problems.length}):`)
  out()
  for (const problem of problems) out(`- ${problem}`)
} else {
  out(
    'PASS: every route rendered with no checker failure and no keyboard finding. Review items above still need their individual reviewed resolution.'
  )
}
out()

const markdown = `${lines.join('\n')}\n`
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), markdown)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
console.log(markdown)
if (problems.length) process.exitCode = 1
