import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import { REVIEW_DIR, type RouteSpec, type WalkContext } from './plan'
import { resolutionFor } from './review-resolutions'

const FOOTER_ROUTES = [
  'admin-feed',
  'admin-roadmap',
  'admin-changelog',
  'admin-post',
  'admin-notifications',
  'anonymous-feed',
  'anonymous-post',
]

/** Capture each new footer review item without changing checker acceptance. */
export async function captureFooterSpacing(
  page: Page,
  route: RouteSpec,
  ctx: WalkContext
): Promise<void> {
  if (
    !FOOTER_ROUTES.includes(route.id) ||
    ctx.viewport !== 'desktop-fine' ||
    ctx.motion !== 'reduce'
  )
    return
  fs.mkdirSync(REVIEW_DIR, { recursive: true })
  const style = await page.addStyleTag({
    content: `
    * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
    p { margin-bottom: 2em !important; }
  `,
  })
  const viewport = page.viewportSize()
  try {
    for (const [width, selector, text, kind] of [
      [320, '.venturi-footer__copyright', /^© \d{4} Venturi Systems, Inc\.$/, 'copyright'],
      [1024, '.venturi-footer__brand p', /^The system of record for AI\.$/, 'brand'],
      [1024, '.venturi-footer__copyright', /^© \d{4} Venturi Systems, Inc\.$/, 'copyright'],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      // The feed already holds pagination while keyboard focus follows its
      // sentinel. Exercise that supported footer state instead of blurring it
      // and letting newly loaded cards push the footer away during capture.
      const focusedAnchor = page
        .locator(kind === 'copyright' ? '.venturi-footer__legal a' : '.venturi-footer__brand a')
        .first()
      await focusedAnchor.focus()
      await expect(focusedAnchor).toBeFocused()
      const element = page.locator(selector)
      await expect(element).toHaveCount(1)
      await expect(element).toHaveText(text)
      const measure = () =>
        element.evaluate((node) => {
          const box = node.getBoundingClientRect(),
            style = getComputedStyle(node)
          const size = parseFloat(style.fontSize)
          const active = document.activeElement
          const focusedFooterAnchor =
            active instanceof HTMLAnchorElement && node.closest('footer')?.contains(active)
              ? {
                  href: active.href,
                  label: active.getAttribute('aria-label') || active.textContent?.trim(),
                }
              : null
          return {
            focusedFooterAnchor,
            checkerText: node.textContent!.replace(/\s+/g, ' ').trim(),
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
            pageBox: {
              x: box.x + scrollX,
              y: box.y + scrollY,
              width: box.width,
              height: box.height,
            },
            fullyVisible:
              box.width > 0 &&
              box.height > 0 &&
              box.left >= 0 &&
              box.top >= 0 &&
              box.right <= innerWidth &&
              box.bottom <= innerHeight,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            spacing: {
              line: parseFloat(style.lineHeight) / size,
              letter: parseFloat(style.letterSpacing) / size,
              word: parseFloat(style.wordSpacing) / size,
            },
          }
        })
      type Measurement = Awaited<ReturnType<typeof measure>>
      let capture:
        { measurement: Measurement; elementPngBase64: string; pngBase64: string } | undefined
      // Feed pagination can move the footer after scrolling. Keep the real page
      // running, and accept evidence only while the entire target remains stable
      // inside the viewport throughout both captures. Full-page capture can
      // trigger more feed loading and omit the footer from its initial extent.
      await expect
        .poll(
          async () => {
            await element.scrollIntoViewIfNeeded()
            await page.evaluate(
              () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
                )
            )
            const before = await measure()
            if (!before.fullyVisible || !before.focusedFooterAnchor) return false
            const elementPngBase64 = (
              await element.screenshot({ animations: 'disabled' })
            ).toString('base64')
            const between = await measure()
            if (JSON.stringify(before) !== JSON.stringify(between)) return false
            const pngBase64 = (
              await page.screenshot({ fullPage: false, animations: 'disabled' })
            ).toString('base64')
            const after = await measure()
            if (JSON.stringify(before) !== JSON.stringify(after)) return false
            capture = { measurement: after, elementPngBase64, pngBase64 }
            return true
          },
          {
            timeout: 15_000,
            message: `Stable visible footer evidence for ${route.id} at ${width}px`,
          }
        )
        .toBe(true)
      if (!capture) throw new Error('Footer evidence was not captured')
      const { measurement, elementPngBase64, pngBase64 } = capture
      const resolution = resolutionFor(route.id, measurement.checkerText, `${width}s`)
      const disposition = resolution
        ? `RESOLVED: ${resolution.resolution}`
        : 'REVIEW_REQUIRED: inspect this element and its footer context before recording a resolution.'
      fs.writeFileSync(
        path.join(REVIEW_DIR, `${route.id}__${width}__footer-${kind}__spacing.json`),
        JSON.stringify(
          {
            schema: 'venturi.portal-spacing-review.v2',
            source: process.env.GITHUB_SHA ?? null,
            route: route.id,
            identity: route.identity,
            url: page.url(),
            viewport: page.viewportSize(),
            locale: 'en-US',
            textSpacingStress: true,
            contextCapture: 'viewport',
            capturedAt: new Date().toISOString(),
            regions: [
              {
                selector,
                expectedText: text.source,
                ...measurement,
                disposition,
                elementPngBase64,
              },
            ],
            disposition,
            pngBase64,
          },
          null,
          2
        ) + '\n'
      )
    }
  } finally {
    await style.evaluate((element) => element.parentNode?.removeChild(element))
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    if (viewport) await page.setViewportSize(viewport)
  }
}
