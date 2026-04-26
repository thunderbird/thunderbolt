import { test, expect } from '@playwright/test'

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chats/new')
    await page.waitForTimeout(2000)
    await page.getByText('Settings').click()
    await page.waitForURL(/\/settings/, { timeout: 5000 })
  })

  test('settings page renders', async ({ page }) => {
    // Should have settings content
    const body = await page.locator('body').innerText()
    expect(body.length).toBeGreaterThan(0)
    await page.screenshot({ path: '/tmp/e2e-settings.png' })
  })

  test('settings page has navigation back to chat', async ({ page }) => {
    const newChat = page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'New Chat' })
    await expect(newChat).toBeVisible()
  })
})
