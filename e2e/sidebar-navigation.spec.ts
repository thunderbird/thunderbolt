import { test, expect } from '@playwright/test'
import { goToNewChat } from './helpers'

test.describe('Sidebar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('New Chat button is visible and clickable', async ({ page }) => {
    const newChat = page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'New Chat' })
    await expect(newChat).toBeVisible()
    await newChat.click()
    await page.waitForTimeout(500)
    // Should stay on or navigate to a new chat
    expect(page.url()).toContain('/chats/')
  })

  test('Settings link navigates to settings page', async ({ page }) => {
    const settings = page.getByText('Settings')
    await expect(settings).toBeVisible()
    await settings.click()
    await page.waitForURL(/\/settings/, { timeout: 5000 })
    expect(page.url()).toContain('/settings')
  })

  test('Automations link navigates to automations page', async ({ page }) => {
    const automations = page.getByText('Automations')
    await expect(automations).toBeVisible()
    await automations.click()
    await page.waitForTimeout(1000)
    // Should navigate to automations
    await page.screenshot({ path: '/tmp/e2e-automations.png' })
  })

  test('can navigate back to chat from settings', async ({ page }) => {
    // Go to settings
    await page.getByText('Settings').click()
    await page.waitForURL(/\/settings/, { timeout: 5000 })

    // Settings sidebar shows "Back" button — use goBack or click Thunderbolt logo
    await page.goBack()
    await page.waitForTimeout(1000)
    expect(page.url()).toContain('/chats/')
  })
})
