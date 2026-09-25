import type { Page } from '@playwright/test'

export type RequiredBrowserZoom = 2 | 4

/**
 * Prepared acceptance helper; NOT_RUN. This reads the existing Chromium page.
 * The owner must supply an approved browser-level zoom actuator separately.
 * Call immediately before and after each geometry/accessibility exercise and
 * retain both returned measurements; this helper does not provide an actuator.
 *
 * Chromium reports browser page zoom separately from device density and pinch:
 * https://github.com/chromium/chromium/blob/f3ee0516f5e07c371c2b836d4cd685764dc0a7a8/third_party/blink/renderer/core/inspector/inspector_page_agent.cc
 * CDP exposes that factor as the optional VisualViewport.zoom field:
 * https://chromedevtools.github.io/devtools-protocol/tot/Page/#type-VisualViewport
 */
export async function assertActualBrowserZoom(page: Page, expected: RequiredBrowserZoom) {
  if (expected !== 2 && expected !== 4) {
    throw new Error('A02 requires an explicit browser zoom factor of 2 or 4')
  }

  const cdp = await page.context().newCDPSession(page)
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics')
    const viewport = metrics.cssVisualViewport
    const zoom = viewport?.zoom
    const scale = viewport?.scale

    // No default for an omitted protocol field and no DOM, environment, CSS,
    // viewport, or deviceScaleFactor fallback can establish browser page zoom.
    if (typeof zoom !== 'number' || !Number.isFinite(zoom) || Math.abs(zoom - expected) > 0.001) {
      throw new Error(
        `A02 prerequisite failed: browser zoom must be ${expected}; ` +
          `CDP reported ${String(zoom)}. CSS/viewport/DPR substitutes are invalid.`
      )
    }

    if (typeof scale !== 'number' || !Number.isFinite(scale) || Math.abs(scale - 1) > 0.001) {
      throw new Error(
        `A02 prerequisite failed: visual viewport scale must be 1; ` +
          `CDP reported ${String(scale)}. Pinch zoom is not browser page zoom.`
      )
    }

    return metrics
  } finally {
    await cdp.detach()
  }
}
