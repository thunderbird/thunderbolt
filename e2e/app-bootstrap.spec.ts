import { test, expect } from '@playwright/test'
import { collectPageErrors, goToNewChat } from './helpers'

test.describe('App Bootstrap', () => {
  test('loads without critical JS errors', async ({ page }) => {
    const errors = collectPageErrors(page)
    await goToNewChat(page)
    expect(errors).toHaveLength(0)
  })

  test('root element renders', async ({ page }) => {
    await page.goto('/')
    const root = page.locator('#root')
    await expect(root).toBeAttached()
  })

  test('redirects / to /chats/*', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL(/\/chats\//, { timeout: 10000 })
    expect(page.url()).toContain('/chats/')
  })

  test('has correct page title', async ({ page }) => {
    await page.goto('/')
    const title = await page.title()
    expect(title).toBe('Thunderbolt')
  })
})
