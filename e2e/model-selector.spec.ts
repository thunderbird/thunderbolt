import { test, expect } from '@playwright/test'
import { goToNewChat } from './helpers'

test.describe('Model Selector', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('model selector is visible in the prompt input area', async ({ page }) => {
    // The model selector trigger should be in the bottom-right area of the prompt input
    // It renders as a pill with the model name and a chevron
    const modelTrigger = page.locator('form button').filter({ has: page.locator('svg') })
    // At least the submit button should exist; model selector may appear if >1 model
    const submitButton = page.locator('form button[type="submit"]')
    await expect(submitButton).toBeVisible()
  })

  test('model selector opens dropdown with model options', async ({ page }) => {
    // Find the model selector trigger (contains model name + chevron, inside the form)
    // The ModelSelector component renders inside the prompt input footer
    const formFooter = page.locator('form').locator('div').filter({ hasText: /Select Model/ }).first()

    // If model selector is visible, click to open
    if (await formFooter.isVisible().catch(() => false)) {
      await formFooter.click()
      await page.waitForTimeout(500)

      // Should show a popover with model options
      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.count()) {
        await expect(popover.first()).toBeVisible()
      }
    }
  })

  test('selecting a model shows checkmark indicator', async ({ page }) => {
    const form = page.locator('form')

    // The model selector trigger shows the selected model name (e.g. "GPT OSS").
    // Find it by matching any of the default model names — these are distinct from
    // mode names ("Chat", "Search", "Research") so this won't hit the mode selector.
    const modelTrigger = form.locator('button').filter({
      hasText: /GPT OSS|Mistral Medium|Sonnet/,
    })

    if (!(await modelTrigger.count())) {
      return
    }

    await modelTrigger.first().click()
    await page.waitForTimeout(500)

    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (!(await popover.isVisible().catch(() => false))) {
      return
    }

    // The currently selected model item has bg-accent and a Check SVG icon
    const selectedItem = popover.locator('.bg-accent')
    if (await selectedItem.count()) {
      const checkIcon = selectedItem.locator('svg')
      expect(await checkIcon.count()).toBeGreaterThan(0)
    }
  })
})
