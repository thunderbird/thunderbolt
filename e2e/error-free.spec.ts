import { test, expect } from '@playwright/test'

test.describe('No Console Errors', () => {
  test('chat page has no critical console errors', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        // Filter known noise
        if (
          !text.includes('favicon') &&
          !text.includes('ERR_CONNECTION_REFUSED') &&
          !text.includes('net::ERR_') &&
          !text.includes('posthog') &&
          !text.includes('PostHog') &&
          !text.includes('Failed to load resource')
        ) {
          consoleErrors.push(text)
        }
      }
    })

    await page.goto('/chats/new')
    await page.waitForTimeout(4000)

    if (consoleErrors.length > 0) {
      console.error('Console errors:', consoleErrors)
    }
    expect(consoleErrors).toHaveLength(0)
  })

  test('settings page has no critical console errors', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (
          !text.includes('favicon') &&
          !text.includes('ERR_CONNECTION_REFUSED') &&
          !text.includes('net::ERR_') &&
          !text.includes('posthog') &&
          !text.includes('PostHog') &&
          !text.includes('Failed to load resource')
        ) {
          consoleErrors.push(text)
        }
      }
    })

    await page.goto('/chats/new')
    await page.waitForTimeout(2000)
    await page.getByText('Settings').click()
    await page.waitForTimeout(2000)

    if (consoleErrors.length > 0) {
      console.error('Console errors:', consoleErrors)
    }
    expect(consoleErrors).toHaveLength(0)
  })

  test('no uncaught JS exceptions on chat page', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => {
      if (
        !err.message.includes('__TAURI__') &&
        !err.message.includes('tauri') &&
        !err.message.includes('window.__TAURI_INTERNALS__')
      ) {
        pageErrors.push(err.message)
      }
    })

    await page.goto('/chats/new')
    await page.waitForTimeout(4000)

    // Interact with the page to trigger any lazy errors
    const textarea = page.locator('textarea')
    if (await textarea.isVisible()) {
      await textarea.click()
      await textarea.fill('test input')
      await page.waitForTimeout(500)
    }

    if (pageErrors.length > 0) {
      console.error('Page errors:', pageErrors)
    }
    expect(pageErrors).toHaveLength(0)
  })

  test('no uncaught JS exceptions navigating between pages', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => {
      if (
        !err.message.includes('__TAURI__') &&
        !err.message.includes('tauri') &&
        !err.message.includes('window.__TAURI_INTERNALS__')
      ) {
        pageErrors.push(err.message)
      }
    })

    // Navigate through all main pages
    await page.goto('/chats/new')
    await page.waitForTimeout(2000)

    await page.getByText('Settings').click()
    await page.waitForTimeout(1000)

    // Navigate back from settings
    await page.goBack()
    await page.waitForTimeout(1000)

    await page.getByText('Automations').click()
    await page.waitForTimeout(1000)

    await page.getByText('New Chat').click()
    await page.waitForTimeout(1000)

    if (pageErrors.length > 0) {
      console.error('Page errors during navigation:', pageErrors)
    }
    expect(pageErrors).toHaveLength(0)
  })
})
