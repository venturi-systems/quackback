import type { CDPSession, Page } from '@playwright/test'

type FontEvidence = {
  familyName: string | null
  postScriptName: string | null
  isCustomFont: boolean | null
  glyphCount: number | null
}

type NodeFontEvidence = {
  nodePath: string
  inputIndices: number[]
  nodeId: number | null
  matchCount: number | null
  status: 'pass' | 'review-required'
  fonts: FontEvidence[]
  totalGlyphCount: number
  reasons: string[]
}

export type RenderedFontEvidence = {
  schema: 'venturi.rendered-font-evidence.v1'
  status: 'pass' | 'review-required'
  expectedFamily: string
  startedAt: string
  finishedAt: string
  requestedPathCount: number
  uniquePathCount: number
  nodes: NodeFontEvidence[]
  reasons: string[]
}

/**
 * Prepared review artifact; NOT_RUN. Observes an existing Chromium page only.
 * Supply every finding.lines[].fragments[].nodePath from the same unchanged
 * typography snapshot. Duplicate paths share one query; inputIndices retain
 * their provenance. Pass is scoped to these text-parent nodes at measurement.
 * Font readiness, computed family, and locale never waive missing glyph proof.
 *
 * CDP reports the fonts used for child TextNodes, their glyphCount and whether
 * each is a custom font. Querying only an enclosing heading is insufficient.
 * https://github.com/ChromeDevTools/devtools-protocol/blob/692abe8ea60a2203ae6d3e8435ba1c1d70c3ee36/pdl/domains/CSS.pdl
 * https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-querySelectorAll
 */
export async function measureRenderedFonts(
  page: Page,
  nodePaths: string[],
  expectedFamily = 'DM Sans'
): Promise<RenderedFontEvidence> {
  const result: RenderedFontEvidence = {
    schema: 'venturi.rendered-font-evidence.v1',
    status: 'review-required',
    expectedFamily,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    requestedPathCount: nodePaths.length,
    uniquePathCount: 0,
    nodes: [],
    reasons: [],
  }
  const byPath = new Map<string, NodeFontEvidence>()
  nodePaths.forEach((nodePath, index) => {
    const existing = byPath.get(nodePath)
    if (existing) {
      existing.inputIndices.push(index)
      return
    }
    const node: NodeFontEvidence = {
      nodePath,
      inputIndices: [index],
      nodeId: null,
      matchCount: null,
      status: 'review-required',
      fonts: [],
      totalGlyphCount: 0,
      reasons: [],
    }
    byPath.set(nodePath, node)
    result.nodes.push(node)
  })
  result.uniquePathCount = result.nodes.length
  if (!result.nodes.length) result.reasons.push('no-text-parent-paths-supplied')
  if (typeof expectedFamily !== 'string' || !expectedFamily.trim()) {
    result.reasons.push('expected-family-missing')
  }

  let cdp: CDPSession | undefined
  try {
    if (!result.reasons.length) {
      cdp = await page.context().newCDPSession(page)
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      const document = await cdp.send('DOM.getDocument', { depth: 1, pierce: false })
      const rootId = document.root?.nodeId
      if (!Number.isInteger(rootId) || rootId <= 0) {
        result.reasons.push('document-root-evidence-missing')
      } else {
        for (const node of result.nodes) {
          if (typeof node.nodePath !== 'string' || !node.nodePath.trim()) {
            node.reasons.push('text-parent-path-missing')
            continue
          }
          try {
            const matches = await cdp.send('DOM.querySelectorAll', {
              nodeId: rootId,
              selector: node.nodePath,
            })
            if (!Array.isArray(matches.nodeIds)) {
              node.reasons.push('selector-result-evidence-missing')
              continue
            }
            node.matchCount = matches.nodeIds.length
            if (matches.nodeIds.length !== 1) {
              node.reasons.push('text-parent-path-must-match-exactly-one-node')
              continue
            }
            const nodeId = matches.nodeIds[0]
            if (!Number.isInteger(nodeId) || nodeId <= 0) {
              node.reasons.push('text-parent-node-id-invalid')
              continue
            }
            node.nodeId = nodeId
            const usage = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
            if (!Array.isArray(usage.fonts) || usage.fonts.length === 0) {
              node.reasons.push('rendered-font-evidence-missing')
              continue
            }
            for (const font of usage.fonts) {
              const evidence: FontEvidence = {
                familyName: typeof font?.familyName === 'string' ? font.familyName : null,
                postScriptName:
                  typeof font?.postScriptName === 'string' ? font.postScriptName : null,
                isCustomFont: typeof font?.isCustomFont === 'boolean' ? font.isCustomFont : null,
                glyphCount:
                  typeof font?.glyphCount === 'number' &&
                  Number.isInteger(font.glyphCount) &&
                  font.glyphCount >= 0
                    ? font.glyphCount
                    : null,
              }
              node.fonts.push(evidence)
              if (
                evidence.familyName !== expectedFamily &&
                !evidence.familyName?.startsWith(`${expectedFamily} `)
              )
                node.reasons.push('unexpected-rendered-font-family')
              if (!evidence.postScriptName) node.reasons.push('postscript-font-identity-missing')
              if (evidence.isCustomFont !== true)
                node.reasons.push('custom-font-evidence-missing-or-system-fallback')
              if (evidence.glyphCount === null) node.reasons.push('glyph-count-evidence-invalid')
              else node.totalGlyphCount += evidence.glyphCount
            }
            if (node.totalGlyphCount <= 0) node.reasons.push('no-positive-rendered-glyph-count')
            node.reasons = [...new Set(node.reasons)]
            if (!node.reasons.length) node.status = 'pass'
          } catch {
            // No transport error strings are retained: they can contain URLs.
            node.reasons.push('node-or-platform-font-api-evidence-unavailable')
          }
        }
      }
    }
  } catch {
    result.reasons.push('chromium-dom-css-session-evidence-unavailable')
  } finally {
    if (cdp) {
      try {
        await cdp.detach()
      } catch {
        result.reasons.push('cdp-session-detach-unconfirmed')
      }
    }
  }
  if (
    !result.reasons.length &&
    result.nodes.length > 0 &&
    result.nodes.every((node) => node.status === 'pass')
  ) {
    result.status = 'pass'
  }
  result.finishedAt = new Date().toISOString()
  return result
}
