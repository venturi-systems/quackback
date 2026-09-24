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
