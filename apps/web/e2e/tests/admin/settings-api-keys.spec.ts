import { test, expect } from '@playwright/test'

test.describe('Admin API Keys Settings', () => {
  test.beforeEach(async ({ page }) => {
    // API keys live under the Developers page → Keys tab.
    await page.goto('/admin/settings/developers?tab=keys')
    await page.waitForLoadState('networkidle')
  })

  test('displays API keys settings page', async ({ page }) => {
    const pageContent = page.getByText(/api keys/i).or(page.getByText(/programmatic access/i))
    await expect(pageContent.first()).toBeVisible({ timeout: 10000 })
  })

  test('shows page header description', async ({ page }) => {
    // The Developers page header description, verbatim from
    // routes/admin/settings.developers.tsx. API keys no longer have a page of
    // their own -- they are the `keys` tab here -- and the old string
    // ("manage api keys for programmatic access") exists nowhere in the tree.
    await expect(
      page.getByText('API keys, webhooks, and the MCP server for programmatic integrations.')
    ).toBeVisible({ timeout: 10000 })
  })

  test('shows create API key button or empty state action', async ({ page }) => {
    await page.waitForTimeout(500)

    // Either the "Create Key" button (when keys exist) or "Create your first API key" (empty state)
    const createButton = page
      .getByRole('button', { name: /create key/i })
      .or(page.getByRole('button', { name: /create your first api key/i }))

    await expect(createButton.first()).toBeVisible({ timeout: 10000 })
  })

  test('can open create API key dialog', async ({ page }) => {
    await page.waitForTimeout(500)

    const createButton = page
      .getByRole('button', { name: /create key/i })
      .or(page.getByRole('button', { name: /create your first api key/i }))

    await createButton.first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    await expect(dialog.getByText(/create api key/i)).toBeVisible()
  })

  test('create dialog has name input', async ({ page }) => {
    await page.waitForTimeout(500)

    const createButton = page
      .getByRole('button', { name: /create key/i })
      .or(page.getByRole('button', { name: /create your first api key/i }))

    await createButton.first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Name input
    await expect(dialog.getByRole('textbox', { name: /^name$/i })).toBeVisible()

    // Action buttons
    await expect(dialog.getByRole('button', { name: /cancel/i })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /create key/i })).toBeVisible()
  })

  test('create dialog cancel closes the dialog', async ({ page }) => {
    await page.waitForTimeout(500)

    const createButton = page
      .getByRole('button', { name: /create key/i })
      .or(page.getByRole('button', { name: /create your first api key/i }))

    await createButton.first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(dialog).toBeHidden({ timeout: 5000 })
  })

  test('created key is revealed once in a dialog with copy button', async ({ page }) => {
    await page.waitForTimeout(500)

    const keyName = `E2E Key ${Date.now()}`

    const createButton = page
      .getByRole('button', { name: /create key/i })
      .or(page.getByRole('button', { name: /create your first api key/i }))

    await createButton.first().click()

    // Name the two dialogs by their titles. Both were `page.getByRole('dialog')`,
    // so once the reveal dialog opened the "create dialog" locator resolved to
    // IT and `toBeHidden` could never pass -- the assertion was self-defeating,
    // not a product failure.
    const createDialog = page.getByRole('dialog', { name: 'Create API Key' })
    await expect(createDialog).toBeVisible({ timeout: 5000 })

    await createDialog.getByRole('textbox', { name: /^name$/i }).fill(keyName)
    await createDialog.getByRole('button', { name: /create key/i }).click()

    // Create dialog closes and reveal dialog opens
    await expect(createDialog).toBeHidden({ timeout: 10000 })

    const revealDialog = page.getByRole('dialog', { name: 'API Key Created' })
    await expect(revealDialog).toBeVisible({ timeout: 10000 })

    // Should show "API Key Created" title
    await expect(revealDialog.getByRole('heading', { name: 'API Key Created' })).toBeVisible()

    // The key value should be visible in a code element. Scope to the secret
    // row: SecretRevealDialog also renders a second <code> for the curl usage
    // example, so an unscoped `code` is a strict-mode violation.
    const copyButton = revealDialog.getByRole('button', {
      name: /copy your api key to clipboard/i,
    })
    // `has:` re-applies the inner locator's whole selector chain relative to
    // each candidate div, so a `copyButton` rooted at `revealDialog` asks for a
    // nested dialog and matches nothing. Root the inner locator at the page --
    // the outer `revealDialog.locator('div')` already scopes the candidates.
    const secretRow = revealDialog
      .locator('div')
      .filter({ has: page.getByRole('button', { name: /copy your api key to clipboard/i }) })
      .last()
    await expect(secretRow.locator('code')).toBeVisible()

    // Copy button should be present (aria-label contains "copy")
    await expect(copyButton).toBeVisible()

    // Dismiss the reveal dialog
    await revealDialog.getByRole('button', { name: /i've saved my key/i }).click()
    await expect(revealDialog).toBeHidden({ timeout: 5000 })

    // Key should now appear in the list
    await expect(page.getByText(keyName)).toBeVisible({ timeout: 10000 })
  })

  test('API key list shows key name and creation date', async ({ page }) => {
    await page.waitForTimeout(500)

    // If there are existing keys, check name and "Created X ago" text
    const keyItems = page
      .locator('div')
      .filter({ has: page.locator('code') })
      .first()

    if ((await keyItems.count()) > 0) {
      // Creation date uses formatDistanceToNow — matches "ago"
      const createdText = page.getByText(/created .* ago/i)
      if ((await createdText.count()) > 0) {
        await expect(createdText.first()).toBeVisible()
      }
    }
  })

  test('key list shows key prefix', async ({ page }) => {
    await page.waitForTimeout(500)

    // Key prefix is rendered as <code>prefix...</code>
    const keyPrefixCode = page.locator('code').filter({ hasText: /\.\.\.$/ })

    if ((await keyPrefixCode.count()) > 0) {
      await expect(keyPrefixCode.first()).toBeVisible()
    }
  })

  test('can open revoke confirmation dialog for an existing key', async ({ page }) => {
    await page.waitForTimeout(500)

    // Create a key first if none exist
    const revokeButtons = page.getByRole('button', { name: /revoke .* api key/i })

    if ((await revokeButtons.count()) === 0) {
      // Create one
      const keyName = `Revoke Test ${Date.now()}`
      const createButton = page
        .getByRole('button', { name: /create key/i })
        .or(page.getByRole('button', { name: /create your first api key/i }))

      await createButton.first().click()
      const createDialog = page.getByRole('dialog')
      await expect(createDialog).toBeVisible({ timeout: 5000 })
      await createDialog.getByRole('textbox', { name: /^name$/i }).fill(keyName)
      await createDialog.getByRole('button', { name: /create key/i }).click()
      await expect(createDialog).toBeHidden({ timeout: 10000 })

      // Dismiss reveal dialog
      const revealDialog = page.getByRole('dialog')
      await expect(revealDialog).toBeVisible({ timeout: 10000 })
      await revealDialog.getByRole('button', { name: /i've saved my key/i }).click()
      await expect(revealDialog).toBeHidden({ timeout: 5000 })
    }

    // Click the revoke button (trash icon, aria-label "Revoke X API key")
    const revokeBtn = page.getByRole('button', { name: /revoke .* api key/i }).first()

    if ((await revokeBtn.count()) > 0) {
      await revokeBtn.click()

      // Confirmation dialog should appear
      const confirmDialog = page.getByRole('alertdialog').or(page.getByRole('dialog'))
      await expect(confirmDialog).toBeVisible({ timeout: 5000 })

      // Should have "Revoke API Key" title
      await expect(confirmDialog.getByText(/revoke api key/i)).toBeVisible()

      // Should warn that the action cannot be undone
      await expect(confirmDialog.getByText(/cannot be undone/i)).toBeVisible()

      // Cancel the revocation
      await confirmDialog.getByRole('button', { name: /cancel/i }).click()
      await expect(confirmDialog).toBeHidden({ timeout: 5000 })
    }
  })

  test('shows API usage guide section', async ({ page }) => {
    // ApiUsageGuide is rendered below the settings card
    const usageGuide = page.getByText(/usage/i).or(page.getByText(/curl/i))
    await expect(usageGuide.first()).toBeVisible({ timeout: 10000 })
  })

  test('shows "never used" label for keys that have not been used', async ({ page }) => {
    await page.waitForTimeout(500)

    const neverUsed = page.getByText(/never used/i)

    // May not exist if all keys have been used
    if ((await neverUsed.count()) > 0) {
      await expect(neverUsed.first()).toBeVisible()
    }
  })
})
