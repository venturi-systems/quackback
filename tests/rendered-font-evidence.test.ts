import { describe, expect, it, vi } from 'vitest'
import {
  measureRenderedFonts,
  observeRenderedFonts,
  renderedFontsMatch,
} from '../apps/web/e2e/utils/rendered-font-evidence'

const customFont = {
  familyName: 'DM Sans 9pt',
  postScriptName: 'DMSans9pt-Regular',
  isCustomFont: true,
  glyphCount: 12,
}
const systemFont = {
  familyName: 'Noto Sans Arabic',
  postScriptName: 'NotoSansArabic-Regular',
  isCustomFont: false,
  glyphCount: 8,
}

function browserEvidence(
  fonts: unknown = [customFont],
  options: { nodeIds?: number[]; failFonts?: boolean; failDetach?: boolean } = {}
) {
  const send = vi.fn(async (method: string) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelectorAll') return { nodeIds: options.nodeIds ?? [2] }
    if (method === 'CSS.getPlatformFontsForNode') {
      if (options.failFonts) throw new Error('private-transport-detail')
      return { fonts }
    }
    return {}
  })
  const detach = vi.fn(async () => {
    if (options.failDetach) throw new Error('private-transport-detail')
  })
  const newCDPSession = vi.fn(async () => ({ send, detach }))
  const page = { context: () => ({ newCDPSession }) } as unknown as Parameters<
    typeof observeRenderedFonts
  >[0]
  return { page, send, detach, newCDPSession }
}

describe('REQ-14/REQ-15 rendered glyph evidence and locale policy separation', () => {
  it('preserves strict custom DM Sans acceptance', async () => {
    const { page, detach } = browserEvidence()
    const result = await measureRenderedFonts(page, ['#title'])
    expect(result.status).toBe('pass')
    expect(result.observationStatus).toBe('measured')
    expect(result.expectedFamily).toBe('DM Sans')
    expect(detach).toHaveBeenCalledOnce()
  })

  it.each([
    systemFont,
    { ...customFont, familyName: 'Unexpected Custom Face' },
    { ...customFont, isCustomFont: false },
  ])('strict policy rejects an unexpected or system font: %j', async (font) => {
    const { page } = browserEvidence([font])
    const result = await measureRenderedFonts(page, ['#title'])
    expect(result.status).toBe('review-required')
    expect(result.observationStatus).toBe('measured')
    expect(result.nodes[0].reasons.length).toBeGreaterThan(0)
  })

  it('observes every mixed-script font without approving an observed family', async () => {
    const { page } = browserEvidence([systemFont, customFont])
    const result = await observeRenderedFonts(page, ['#title'])
    expect(result.observationStatus).toBe('measured')
    expect(result.expectedFamily).toBeNull()
    expect(result.status).toBe('review-required')
    expect(result.nodes[0].status).toBe('review-required')
    expect(result.nodes[0].fonts).toEqual([systemFont, customFont])
    expect(result.reasons).toContain('font-family-policy-requires-locale-review')
  })

  it('retains duplicate fragment provenance with a single platform-font query', async () => {
    const { page, send } = browserEvidence()
    const result = await observeRenderedFonts(page, ['#title', '#title'])
    expect(result.nodes[0].inputIndices).toEqual([0, 1])
    expect(result.requestedPathCount).toBe(2)
    expect(result.uniquePathCount).toBe(1)
    expect(
      send.mock.calls.filter(([method]) => method === 'CSS.getPlatformFontsForNode')
    ).toHaveLength(1)
  })

  it.each([
    { ...systemFont, familyName: '' },
    { ...systemFont, postScriptName: '' },
    { ...systemFont, isCustomFont: undefined },
    { ...systemFont, glyphCount: -1 },
    { ...systemFont, glyphCount: 0.5 },
    { ...systemFont, glyphCount: Number.NaN },
    { ...systemFont, glyphCount: 0 },
  ])('leaves malformed or empty glyph metadata incomplete: %j', async (font) => {
    const { page } = browserEvidence([font])
    const result = await observeRenderedFonts(page, ['#title'])
    expect(result.observationStatus).toBe('incomplete')
    expect(result.status).toBe('review-required')
  })

  it.each([{ nodeIds: [] }, { nodeIds: [2, 3] }])(
    'rejects missing or ambiguous parent nodes: %j',
    async ({ nodeIds }) => {
      const { page, send } = browserEvidence([systemFont], { nodeIds })
      const result = await observeRenderedFonts(page, ['#title'])
      expect(result.observationStatus).toBe('incomplete')
      expect(send.mock.calls.some(([method]) => method === 'CSS.getPlatformFontsForNode')).toBe(
        false
      )
    }
  )

  it('does not treat an empty font response as an observation', async () => {
    const { page } = browserEvidence([])
    expect((await observeRenderedFonts(page, ['#title'])).observationStatus).toBe('incomplete')
  })

  it('does not open CDP when no text parents were supplied', async () => {
    const { page, newCDPSession } = browserEvidence()
    expect((await observeRenderedFonts(page, [])).observationStatus).toBe('incomplete')
    expect(newCDPSession).not.toHaveBeenCalled()
  })

  it('retains only sanitized evidence failure reasons', async () => {
    const { page, detach } = browserEvidence([systemFont], { failFonts: true })
    const result = await observeRenderedFonts(page, ['#title'])
    expect(result.observationStatus).toBe('incomplete')
    expect(JSON.stringify(result)).not.toContain('private-transport-detail')
    expect(detach).toHaveBeenCalledOnce()
  })

  it('cannot report complete observation when CDP detach is unconfirmed', async () => {
    const { page } = browserEvidence([systemFont], { failDetach: true })
    const result = await observeRenderedFonts(page, ['#title'])
    expect(result.observationStatus).toBe('incomplete')
    expect(result.reasons).toContain('cdp-session-detach-unconfirmed')
  })
  it('binds font identities while ignoring timestamps, node IDs and font response order', async () => {
    const before = await observeRenderedFonts(browserEvidence([systemFont, customFont]).page, [
      '#title',
    ])
    const after = structuredClone(before)
    after.startedAt = 'later'
    after.finishedAt = 'later'
    after.nodes[0].nodeId = 99
    after.nodes[0].fonts.reverse()
    expect(renderedFontsMatch(before, after)).toBe(true)
  })

  it.each(['familyName', 'postScriptName', 'isCustomFont', 'glyphCount', 'nodePath'])(
    'detects a changed glyph binding even if computed CSS and geometry stay unchanged: %s',
    async (field) => {
      const before = await observeRenderedFonts(browserEvidence([systemFont]).page, ['#title'])
      const after = structuredClone(before)
      if (field === 'familyName') after.nodes[0].fonts[0].familyName = 'Different face'
      if (field === 'postScriptName') after.nodes[0].fonts[0].postScriptName = 'DifferentFace'
      if (field === 'isCustomFont') after.nodes[0].fonts[0].isCustomFont = true
      if (field === 'glyphCount') after.nodes[0].fonts[0].glyphCount = 7
      if (field === 'nodePath') after.nodes[0].nodePath = '#different-title'
      expect(renderedFontsMatch(before, after)).toBe(false)
    }
  )

  it('refuses stable-glyph claims when either observation is incomplete', async () => {
    const complete = await observeRenderedFonts(browserEvidence().page, ['#title'])
    const incomplete = await observeRenderedFonts(browserEvidence([]).page, ['#title'])
    expect(renderedFontsMatch(complete, incomplete)).toBe(false)
    expect(renderedFontsMatch(incomplete, complete)).toBe(false)
  })
})
