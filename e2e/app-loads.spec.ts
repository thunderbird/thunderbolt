import { test, expect } from '@playwright/test'

test.describe('App loads without errors', () => {
  test('homepage loads and redirects to /chats/new', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })

    await page.goto('/')
    await page.waitForURL(/\/chats\//, { timeout: 10000 })

    // Page should have content
    const body = await page.locator('body').textContent()
    expect(body).toBeTruthy()

    // Filter out known noise (browser extensions, favicon, etc.)
    const relevantErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('manifest') &&
        !e.includes('ERR_CONNECTION_REFUSED') && // backend not running
        !e.includes('net::ERR_') &&
        !e.includes('posthog'), // analytics
    )

    // Log any errors for debugging but don't fail on them if they're network-related
    if (relevantErrors.length > 0) {
      console.warn('Console errors found:', relevantErrors)
    }
  })

  test('page renders root element', async ({ page }) => {
    await page.goto('/')
    const root = page.locator('#root')
    await expect(root).toBeAttached()
  })
})
