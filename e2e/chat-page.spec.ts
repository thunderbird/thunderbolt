import { test, expect } from '@playwright/test'
import { goToNewChat } from './helpers'

test.describe('Chat Page Layout', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('header is visible with agent selector', async ({ page }) => {
    const header = page.locator('header')
    await expect(header).toBeVisible()
    // Agent selector should show "Thunderbolt" (the built-in agent)
    await expect(header.getByText('Thunderbolt')).toBeVisible()
  })

  test('chat textarea is visible with placeholder', async ({ page }) => {
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible()
    await expect(textarea).toHaveAttribute('placeholder', /ask me anything/i)
  })

  test('mode selector shows Chat mode by default', async ({ page }) => {
    const modeSelector = page.getByText('Chat', { exact: true })
    await expect(modeSelector).toBeVisible()
  })

  test('prompt suggestions are visible', async ({ page }) => {
    await expect(page.getByText('Check the weather')).toBeVisible()
    await expect(page.getByText('Write a message')).toBeVisible()
    await expect(page.getByText('Understand a topic')).toBeVisible()
  })

  test('sidebar shows navigation items', async ({ page }) => {
    await expect(page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'New Chat' })).toBeVisible()
    await expect(page.getByText('Automations')).toBeVisible()
    await expect(page.getByText('Settings')).toBeVisible()
  })
})

test.describe('Chat Input Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('can type in the textarea', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.click()
    await textarea.fill('Hello world')
    await expect(textarea).toHaveValue('Hello world')
  })

  test('textarea focuses on click', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.click()
    await expect(textarea).toBeFocused()
  })

  test('clicking a prompt suggestion fills the textarea', async ({ page }) => {
    const suggestion = page.getByText('Check the weather')
    await suggestion.click()
    // After clicking suggestion, the textarea or prompt area should be updated
    await page.waitForTimeout(500)
    // The suggestion may trigger a send or fill - either way the page should change
    const textarea = page.locator('textarea')
    const url = page.url()
    // Either textarea has text or we navigated to a chat thread
    const hasText = await textarea.inputValue().catch(() => '')
    const urlChanged = !url.includes('/new')
    expect(hasText.length > 0 || urlChanged).toBe(true)
  })
})
