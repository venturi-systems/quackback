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
    for (const [width, selector, text] of [
      [320, '.venturi-footer__copyright', /^© \d{4} Venturi Systems, Inc\.$/],
      [1024, '.venturi-footer__brand p', /^The system of record for AI\.$/],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(async () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        await document.fonts.ready
      })
      const element = page.locator(selector)
      await expect(element).toHaveCount(1)
      await expect(element).toHaveText(text)
      await element.scrollIntoViewIfNeeded()
      const measurement = await element.evaluate((node) => {
        const box = node.getBoundingClientRect(),
          style = getComputedStyle(node)
        const size = parseFloat(style.fontSize)
        return {
          checkerText: node.textContent!.replace(/\s+/g, ' ').trim(),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          pageBox: { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height },
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          spacing: {
            line: parseFloat(style.lineHeight) / size,
            letter: parseFloat(style.letterSpacing) / size,
            word: parseFloat(style.wordSpacing) / size,
          },
        }
      })
      const resolution = resolutionFor(route.id, measurement.checkerText, `${width}s`)
      const disposition = resolution
        ? `RESOLVED: ${resolution.resolution}`
        : 'REVIEW_REQUIRED: inspect this element and its footer context before recording a resolution.'
      const elementPngBase64 = (await element.screenshot({ animations: 'disabled' })).toString(
        'base64'
      )
      const pngBase64 = (
        await page.screenshot({ fullPage: true, animations: 'disabled' })
      ).toString('base64')
      fs.writeFileSync(
        path.join(REVIEW_DIR, `${route.id}__${width}__footer__spacing.json`),
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
    await style.evaluate((element) => element.remove())
    if (viewport) await page.setViewportSize(viewport)
  }
}
