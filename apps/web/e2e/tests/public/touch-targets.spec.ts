import { test, expect, type Locator, type Page } from '@playwright/test'
import { getPostWithOwnComment } from '../../utils/db-helpers'

// Exercise the actual portal and composed Radix triggers, rather than a button
// fixture: Tooltip/Popover/DropdownMenu can replace a Button's data-slot.
async function useSmallRoot(page: Page) {
  // SSR controls are visible before their click handlers hydrate.
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.addStyleTag({ content: 'html { font-size: 14px !important; }' })
  await expect(page.locator('html')).toHaveCSS('font-size', '14px')
}

async function expectTouchTarget(control: Locator) {
  await expect(control).toBeVisible()
  await expect
    .poll(async () => {
      const box = await control.boundingBox()
      return box ? Math.min(box.width, box.height) : 0
    })
    .toBeGreaterThanOrEqual(44)
}

async function expectNoPageOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true)
}

test.describe('Portal coarse-pointer action targets', () => {
  test.use({
    storageState: 'e2e/.auth/admin.json',
    hasTouch: true,
    viewport: { width: 320, height: 800 },
  })

  for (const width of [320, 1024]) {
    test(`feedback controls keep both touch dimensions at a 14px root (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/')
      await useSmallRoot(page)
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)

      for (const name of [/^Notifications/, /^User menu$/, /^Trending$/, /^Top$/, /^New$/]) {
        await expectTouchTarget(page.getByRole('button', { name }))
      }
      for (const name of [/^Search$/, /^Filter/]) {
        await expectTouchTarget(page.getByRole('button', { name }).first())
      }
      await expectTouchTarget(page.getByTestId('vote-button').first())
      if (width >= 1024) {
        await expectTouchTarget(page.getByRole('button', { name: /^View all posts$/i }))
      }
      await expectNoPageOverflow(page)

      await page.getByRole('button', { name: /^Search$/ }).first().click()
      const search = page.getByPlaceholder(/Search posts/i)
      await expect(search).toBeVisible()
      const form = page.locator('form').filter({ has: page.getByPlaceholder(/Search posts/i) })
      await expectTouchTarget(form.getByRole('button', { name: /^Search$/ }))
      const formBox = await form.boundingBox()
      expect(formBox).not.toBeNull()
      expect(formBox!.x).toBeGreaterThanOrEqual(0)
      expect(formBox!.x + formBox!.width).toBeLessThanOrEqual(width)
      await expectNoPageOverflow(page)
    })
  }

  test('post detail actions fit the mobile page at a 14px root', async ({ page }) => {
    const post = getPostWithOwnComment('demo@example.com')
    await page.goto(post.path)
    await expect(page).toHaveURL((url) => url.pathname === post.path)
    await useSmallRoot(page)
    const detail = page.getByTestId('post-detail')
    await expect(detail).toBeVisible()
    await expectTouchTarget(detail.getByTestId('vote-button').first())
    const ownComment = detail.locator(`[id="comment-${post.commentId}"]`)
    await expect(ownComment).toBeVisible()
    for (const name of ['Reply', 'Edit', 'Delete']) {
      await expectTouchTarget(ownComment.getByRole('button', { name, exact: true }).first())
    }
    const buttons = detail.locator(
      "button:not([role='checkbox']):not([role='switch']):not([role='radio'])"
    )
    for (const button of await buttons.all()) {
      // Collapsed reply forms stay mounted for their grid animation. Their
      // transparent descendants have boxes but are not rendered actions.
      const rendered = await button.evaluate((element) =>
        element.checkVisibility({ opacityProperty: true })
      )
      if (rendered) {
        await expectTouchTarget(button)
        const box = (await button.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        const name = (await button.getAttribute('aria-label')) || (await button.textContent())
        expect(box.x + box.width, `Action extends beyond the viewport: ${name}`).toBeLessThanOrEqual(
          320
        )
      }
    }
    await expectNoPageOverflow(page)
  })

  test('roadmap tabs and scroll actions keep both touch dimensions at a 14px root', async ({
    page,
  }) => {
    await page.goto('/roadmap')
    await useSmallRoot(page)
    const tablist = page.getByRole('tablist', { name: 'Roadmaps' })
    await expect(tablist).toBeVisible()
    const tabs = tablist.getByRole('tab')
    expect(await tabs.count()).toBeGreaterThan(0)
    for (const tab of await tabs.all()) {
      await expectTouchTarget(tab)
    }
    // Force a narrower available strip independently of seeded title lengths.
    // ResizeObserver must render the real arrow; no stand-in control is used.
    await page.addStyleTag({
      content: '[role="tablist"][aria-label="Roadmaps"] { max-width: 180px; }',
    })
    await expectTouchTarget(page.getByRole('button', { name: 'Scroll right', exact: true }))
    await expectNoPageOverflow(page)
  })

  test('a roadmap tab label longer than the row wraps whole inside its tab', async ({ page }) => {
    await page.goto('/roadmap')
    await useSmallRoot(page)
    const tablist = page.getByRole('tablist', { name: 'Roadmaps' })
    await expect(tablist).toBeVisible()
    const tab = tablist.getByRole('tab').first()
    const label = tab.locator('[data-text-origin="user"]')
    await expect(label).toHaveCount(1)

    // Seeded roadmap names are short. Give the first tab an admin-written name
    // far wider than the 320px row, in the real row with its real scroll
    // affordances, so the reflow path itself is rendered.
    const longName =
      'Integrations, data connectors and workspace administration planned for the second half of the year'
    await label.evaluate((element, name) => {
      element.textContent = name
    }, longName)
    await tablist.evaluate((element) => element.dispatchEvent(new Event('scroll')))
    await expect(tab).toHaveText(longName)

    const geometry = await tab.evaluate((element) => {
      const text = element.querySelector('[data-text-origin="user"]') as HTMLElement
      const row = element.closest('[role="tablist"]') as HTMLElement
      const tabRect = element.getBoundingClientRect()
      const textRect = text.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const textStyle = getComputedStyle(text)
      const lineHeight = parseFloat(textStyle.lineHeight)
      const fontSize = parseFloat(textStyle.fontSize)
      // Each corner of the label, inset by half-leading to its glyph box, must
      // lie inside the tab's rounded outline (the radius as painted, clamped to
      // half the tab's shorter side).
      const radius = Math.min(
        parseFloat(getComputedStyle(element).borderTopLeftRadius),
        tabRect.width / 2,
        tabRect.height / 2
      )
      const inset = (lineHeight - fontSize) / 2
      const corners = [
        [textRect.left, textRect.top + inset, tabRect.left + radius, tabRect.top + radius],
        [textRect.right, textRect.top + inset, tabRect.right - radius, tabRect.top + radius],
        [textRect.left, textRect.bottom - inset, tabRect.left + radius, tabRect.bottom - radius],
        [textRect.right, textRect.bottom - inset, tabRect.right - radius, tabRect.bottom - radius],
      ]
      const cornersInside = corners.every(([x, y, cx, cy]) => {
        const outsideX = x < tabRect.left + radius || x > tabRect.right - radius
        const outsideY = y < tabRect.top + radius || y > tabRect.bottom - radius
        return !(outsideX && outsideY) || Math.hypot(x - cx, y - cy) <= radius + 0.5
      })
      return {
        tab: { left: tabRect.left, right: tabRect.right },
        row: { left: rowRect.left, right: rowRect.right },
        lines: Math.round(textRect.height / lineHeight),
        unclipped:
          text.scrollWidth <= text.clientWidth + 1 &&
          text.scrollHeight <= text.clientHeight + 1 &&
          textRect.left >= tabRect.left &&
          textRect.right <= tabRect.right + 0.5,
        cornersInside,
      }
    })
    // The label wraps instead of staying on one line, and nothing is clipped.
    expect(geometry.lines).toBeGreaterThan(1)
    expect(geometry.unclipped).toBe(true)
    expect(geometry.cornersInside).toBe(true)
    // The tab stays inside the row.
    expect(geometry.tab.left).toBeGreaterThanOrEqual(geometry.row.left - 0.5)
    expect(geometry.tab.right).toBeLessThanOrEqual(geometry.row.right + 0.5)
    // With the seeded roadmaps the later tabs overflow the row, so the fading
    // scroll affordance shows; the wrapped tab ends before it, leaving the
    // whole label readable. A row that fits shows no affordance to avoid.
    const scrollRight = page.getByRole('button', { name: 'Scroll right', exact: true })
    if (await tablist.evaluate((element) => element.scrollWidth > element.clientWidth + 1)) {
      await expectTouchTarget(scrollRight)
      const arrow = (await scrollRight.boundingBox())!
      expect(geometry.tab.right).toBeLessThanOrEqual(arrow.x + 0.5)
    } else {
      await expect(scrollRight).toHaveCount(0)
    }
    await expectTouchTarget(tab)
    await expectNoPageOverflow(page)
  })
})

test.describe('Portal fine-pointer action sizing', () => {
  test.use({
    storageState: 'e2e/.auth/admin.json',
    hasTouch: false,
    viewport: { width: 1280, height: 800 },
  })

  test('preserves the compact notification bell on a fine pointer', async ({ page }) => {
    await page.goto('/')
    await useSmallRoot(page)
    expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true)
    const bell = page.getByRole('button', { name: /^Notifications/ })
    await expect(bell).toBeVisible()
    // The bell transitions all properties; wait for the font-size change to
    // settle before comparing the compact, fine-pointer geometry.
    await expect
      .poll(async () => {
        const box = await bell.boundingBox()
        return box && { width: box.width, height: box.height }
      })
      .toEqual({ width: 35, height: 35 })
  })
})
