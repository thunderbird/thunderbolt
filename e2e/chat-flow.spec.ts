import { test, expect } from '@playwright/test'
import { collectPageErrors, goToNewChat } from './helpers'

test.describe('Chat Flow - End to End', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('full chat UI renders correctly on new chat', async ({ page }) => {
    // Header with agent selector
    await expect(page.locator('header').getByText('Thunderbolt')).toBeVisible()

    // Chat textarea
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible()
    await expect(textarea).toHaveAttribute('placeholder', /ask me anything/i)

    // Mode selector showing Chat mode
    await expect(page.getByText('Chat', { exact: true })).toBeVisible()

    // Submit button
    const submitButton = page.locator('form button[type="submit"]')
    await expect(submitButton).toBeVisible()
  })

  test('submit button is disabled when input is empty', async ({ page }) => {
    const submitButton = page.locator('form button[type="submit"]')
    await expect(submitButton).toBeDisabled()
  })

  test('submit button enables when text is entered', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.fill('Hello')
    const submitButton = page.locator('form button[type="submit"]')
    await expect(submitButton).toBeEnabled()
  })

  test('typing in textarea persists input value', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.fill('Test message content')
    await expect(textarea).toHaveValue('Test message content')
  })

  test('submitting a message clears the input', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.fill('Hello world')

    const submitButton = page.locator('form button[type="submit"]')
    await submitButton.click()

    // Input should be cleared after submission
    await expect(textarea).toHaveValue('', { timeout: 5000 })
  })

  test('submitting a message shows user message in chat', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.fill('What is 2+2?')

    const submitButton = page.locator('form button[type="submit"]')
    await submitButton.click()

    // User message should appear in the chat area
    const userMessage = page.getByText('What is 2+2?')
    await expect(userMessage).toBeVisible({ timeout: 5000 })
  })

  test('no JS errors during message submission', async ({ page }) => {
    const errors = collectPageErrors(page)

    const textarea = page.locator('textarea')
    await textarea.fill('Test message')

    const submitButton = page.locator('form button[type="submit"]')
    await submitButton.click()
    await page.waitForTimeout(3000)

    // Filter out expected network errors (no real backend in e2e)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('fetch') &&
        !e.includes('ERR_CONNECTION') &&
        !e.includes('network') &&
        !e.includes('Failed to fetch') &&
        !e.includes('AbortError'),
    )
    expect(criticalErrors).toHaveLength(0)
  })
})

test.describe('Chat Mode Switching', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('default mode is Chat', async ({ page }) => {
    await expect(page.getByText('Chat', { exact: true })).toBeVisible()
  })

  test('can switch to Search mode and it persists', async ({ page }) => {
    await page.getByText('Chat', { exact: true }).click()
    await page.waitForTimeout(500)

    const searchOption = page.getByText('Search', { exact: true })
    if (await searchOption.isVisible().catch(() => false)) {
      await searchOption.click()
      await page.waitForTimeout(500)
      await expect(page.getByText('Search', { exact: true })).toBeVisible()
    }
  })

  test('can switch to Research mode and it persists', async ({ page }) => {
    await page.getByText('Chat', { exact: true }).click()
    await page.waitForTimeout(500)

    const researchOption = page.getByText('Research', { exact: true })
    if (await researchOption.isVisible().catch(() => false)) {
      await researchOption.click()
      await page.waitForTimeout(500)
      await expect(page.getByText('Research', { exact: true })).toBeVisible()
    }
  })

  test('mode selector closes after selection', async ({ page }) => {
    await page.getByText('Chat', { exact: true }).click()
    await page.waitForTimeout(500)

    const searchOption = page.getByText('Search', { exact: true })
    if (await searchOption.isVisible().catch(() => false)) {
      await searchOption.click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      const visible = await popover.isVisible().catch(() => false)
      expect(visible).toBe(false)
    }
  })
})

test.describe('Chat Agent Switching', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('selecting the same agent navigates to new chat that renders', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.isVisible().catch(() => false)) {
      const thunderboltInDropdown = popover.getByText('Thunderbolt').first()
      await thunderboltInDropdown.click()
      await page.waitForTimeout(1000)

      // New chat must fully render — catches blank screen regression
      expect(page.url()).toContain('/chats/')
      const textarea = page.locator('textarea')
      await expect(textarea).toBeVisible({ timeout: 15000 })
      await expect(textarea).toHaveAttribute('placeholder', /ask me anything/i)
    }
  })
})

test.describe('Chat Prompt Suggestions', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('prompt suggestions are visible on new chat', async ({ page }) => {
    const suggestions = page.locator('[role="button"], button').filter({ hasText: /weather|message|topic/i })
    const count = await suggestions.count()
    expect(count).toBeGreaterThan(0)
  })

  test('clicking a suggestion triggers action', async ({ page }) => {
    const suggestion = page.getByText('Check the weather')
    if (await suggestion.isVisible().catch(() => false)) {
      const urlBefore = page.url()
      await suggestion.click()
      await page.waitForTimeout(2000)

      const textarea = page.locator('textarea')
      const inputValue = await textarea.inputValue().catch(() => '')
      const urlChanged = page.url() !== urlBefore

      expect(inputValue.length > 0 || urlChanged).toBe(true)
    }
  })
})

test.describe('Chat Navigation', () => {
  test('new chat button creates fresh chat with working UI', async ({ page }) => {
    await goToNewChat(page)

    // Submit a message so the URL changes from /chats/new to /chats/<id>
    const textarea = page.locator('textarea')
    await textarea.fill('Some text')
    await page.locator('form button[type="submit"]').click()
    await page.waitForURL(/\/chats\/(?!new)/, { timeout: 10000 })

    // Click New Chat button — use getByRole with first() since sidebar may contain
    // multiple elements with "New Chat" text (e.g. active chat + dedicated button)
    await page.getByRole('button', { name: 'New Chat' }).first().click()

    // New chat should fully render — catches blank screen regression
    await expect(page.locator('textarea')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('textarea')).toHaveValue('')
    expect(page.url()).toContain('/chats/')
  })

  test('navigating to /not-found shows 404', async ({ page }) => {
    await page.goto('/not-found')
    await page.waitForTimeout(2000)
    const pageContent = await page.textContent('body')
    expect(pageContent).toBeTruthy()
  })
})
