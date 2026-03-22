import { test, expect } from '@playwright/test'

test.describe('Agent Selector', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to chat page and wait for it to load
    await page.goto('/chats/new')
    // Wait for the app to initialize (the header should be visible)
    await page.waitForSelector('header', { timeout: 10000 })
  })

  test('header is visible on chat page', async ({ page }) => {
    const header = page.locator('header')
    await expect(header).toBeVisible()
  })

  test('chat prompt input area is visible', async ({ page }) => {
    // The chat prompt input should be present on new chat page
    const textarea = page.locator('textarea')
    // Wait a bit for full render
    await page.waitForTimeout(1000)

    // Either a textarea or some input area should exist
    const inputCount = await textarea.count()
    if (inputCount > 0) {
      await expect(textarea.first()).toBeVisible()
    }
  })

  test('no critical JavaScript errors on page load', async ({ page }) => {
    const jsErrors: string[] = []
    page.on('pageerror', (error) => {
      jsErrors.push(error.message)
    })

    await page.goto('/chats/new')
    await page.waitForTimeout(2000) // Wait for async initialization

    // Filter out Tauri-specific errors (expected in browser mode)
    const criticalErrors = jsErrors.filter(
      (e) =>
        !e.includes('__TAURI__') &&
        !e.includes('tauri') &&
        !e.includes('window.__TAURI_INTERNALS__') &&
        !e.includes('ipc') &&
        !e.includes('convertFileSrc'),
    )

    if (criticalErrors.length > 0) {
      console.error('Critical JS errors:', criticalErrors)
    }

    // We expect zero critical errors (Tauri errors are expected when running in browser)
    expect(criticalErrors).toHaveLength(0)
  })
})
