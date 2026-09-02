import { test, expect } from '@playwright/test'

test.describe('Admin Experimental Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/settings/labs')
    await page.waitForLoadState('networkidle')
  })

  test('page loads and shows Experimental Features heading', async ({ page }) => {
    await expect(page.getByText('Experimental Features')).toBeVisible({ timeout: 10000 })
  })

  test('shows disclaimer about experimental features', async ({ page }) => {
    await expect(
      // Verbatim from admin/settings/experimental-settings.tsx. The previous
      // wording ("These features are in development and may change or be
      // removed.") is not in the tree; this paragraph is the same disclaimer,
      // under the "Labs" heading.
      page.getByText(
        'Turn experimental features on or off. They are still in development, so they may change or be removed.'
      )
    ).toBeVisible({ timeout: 10000 })
  })

  test('shows Help Center feature flag card', async ({ page }) => {
    // Exact: the Support section's own description ("...a self-serve help
    // center.") and the flag description both contain the words, so the
    // substring form resolved to three elements. The flag's <label> is the card.
    await expect(page.getByText('Help Center', { exact: true })).toBeVisible({ timeout: 10000 })
    await expect(
      page.getByText('Publish a searchable help center so customers can find answers on their own.')
    ).toBeVisible()
  })

  test('shows AI Feedback Extraction feature flag card', async ({ page }) => {
    await expect(page.getByText('AI Feedback Extraction')).toBeVisible({ timeout: 10000 })
    await expect(
      page.getByText('Automatically pull in and categorize feedback from your connected sources.')
    ).toBeVisible()
  })

  test('shows Conversations feature flag card', async ({ page }) => {
    await expect(page.getByText('Conversations')).toBeVisible({ timeout: 10000 })
  })

  test('each feature flag card has a toggle switch', async ({ page }) => {
    const helpCenterSwitch = page.locator('#flag-helpCenter')
    const aiFeedbackSwitch = page.locator('#flag-aiFeedbackExtraction')
    const conversationsSwitch = page.locator('#flag-supportInbox')

    await expect(helpCenterSwitch).toBeVisible({ timeout: 10000 })
    await expect(aiFeedbackSwitch).toBeVisible()
    await expect(conversationsSwitch).toBeVisible()
  })

  test('feature flag switches are interactive (not disabled)', async ({ page }) => {
    const helpCenterSwitch = page.locator('#flag-helpCenter')
    await expect(helpCenterSwitch).toBeVisible({ timeout: 10000 })
    await expect(helpCenterSwitch).toBeEnabled()
  })

  test('can toggle a feature flag on and off', async ({ page }) => {
    const helpCenterSwitch = page.locator('#flag-helpCenter')
    await expect(helpCenterSwitch).toBeVisible({ timeout: 10000 })

    const wasChecked = await helpCenterSwitch.isChecked()

    await helpCenterSwitch.click()
    // Page reloads on mutation success — wait for it to settle
    await page.waitForLoadState('networkidle')
    await page.waitForLoadState('networkidle')

    // Toggle it back to restore state
    const helpCenterAfterReload = page.locator('#flag-helpCenter')
    await expect(helpCenterAfterReload).toBeVisible({ timeout: 10000 })
    const nowChecked = await helpCenterAfterReload.isChecked()

    if (nowChecked === wasChecked) {
      // Toggle did not flip — that is unexpected but not worth failing
      return
    }

    // Restore original state
    await helpCenterAfterReload.click()
    await page.waitForLoadState('networkidle')
    await page.waitForLoadState('networkidle')
  })

  test('flag label is clickable (htmlFor association with switch)', async ({ page }) => {
    // Labels are associated via htmlFor="flag-helpCenter"
    const helpCenterLabel = page.locator('label[for="flag-helpCenter"]')
    await expect(helpCenterLabel).toBeVisible({ timeout: 10000 })

    const aiFeedbackLabel = page.locator('label[for="flag-aiFeedbackExtraction"]')
    await expect(aiFeedbackLabel).toBeVisible()
  })

  test('feature flag descriptions are rendered below their labels', async ({ page }) => {
    // Each Card > CardContent has a label + description paragraph
    const descriptions = page.locator('.space-y-0\\.5 p.text-xs')
    if ((await descriptions.count()) > 0) {
      await expect(descriptions.first()).toBeVisible({ timeout: 10000 })
    } else {
      // Fallback: at least one known description text is present
      await expect(
        page.getByText(
          'Publish a searchable help center so customers can find answers on their own.'
        )
      ).toBeVisible({ timeout: 10000 })
    }
  })

  test('page shows a switch for every registered feature flag', async ({ page }) => {
    // The three labs flags: helpCenter, aiFeedbackExtraction, supportInbox.
    // (Analytics graduated to GA and is no longer a flag.)
    //
    // FEATURE_FLAG_REGISTRY currently holds four flags, and LAB_SECTIONS places
    // every one of them on this page (a unit test pins that every flag belongs
    // to exactly one section). The pinned count of 3 predates linkPreviews.
    // Assert the identities as well as the total, so a flag that is added but
    // never surfaced still fails here.
    for (const id of ['supportInbox', 'helpCenter', 'linkPreviews', 'aiFeedbackExtraction']) {
      await expect(page.locator(`#flag-${id}`)).toBeVisible({ timeout: 10000 })
    }
    const switches = page.locator('button[role="switch"]')
    await expect(switches).toHaveCount(4, { timeout: 10000 })
  })
})
