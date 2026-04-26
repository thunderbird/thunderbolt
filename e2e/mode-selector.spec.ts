import { test, expect } from '@playwright/test'
import { goToNewChat } from './helpers'

test.describe('Mode Selector', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('shows Chat mode by default', async ({ page }) => {
    const chatMode = page.getByText('Chat', { exact: true })
    await expect(chatMode).toBeVisible()
  })

  test('clicking mode selector opens mode list', async ({ page }) => {
    const chatMode = page.getByText('Chat', { exact: true })
    await chatMode.click()
    await page.waitForTimeout(500)

    // Should show mode options - look for Search and Research
    await page.screenshot({ path: '/tmp/e2e-mode-dropdown.png' })

    // Check if other modes are visible in the dropdown
    const searchMode = page.getByText('Search')
    const researchMode = page.getByText('Research')

    const searchVisible = await searchMode.isVisible().catch(() => false)
    const researchVisible = await researchMode.isVisible().catch(() => false)

    // At least one alternate mode should be visible
    expect(searchVisible || researchVisible).toBe(true)
  })

  test('can switch to Search mode', async ({ page }) => {
    // Open mode selector
    await page.getByText('Chat', { exact: true }).click()
    await page.waitForTimeout(500)

    // Click Search in the dropdown (use exact match to avoid "Research")
    const searchOption = page.getByText('Search', { exact: true })
    await searchOption.click()
    await page.waitForTimeout(500)

    // Verify mode changed - the trigger should now show Search
    const searchTrigger = page.getByText('Search', { exact: true })
    await expect(searchTrigger).toBeVisible()
  })

  test('can switch to Research mode', async ({ page }) => {
    await page.getByText('Chat', { exact: true }).click()
    await page.waitForTimeout(500)

    await page.getByText('Research', { exact: true }).click()
    await page.waitForTimeout(500)

    const researchTrigger = page.getByText('Research', { exact: true })
    await expect(researchTrigger).toBeVisible()
  })
})
