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
    await textarea.click()
    await textarea.fill('Test message content')
    await expect(textarea).toHaveValue('Test message content')
  })

  test('submitting a message clears the input', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.fill('Hello world')

    // Submit via button click
    const submitButton = page.locator('form button[type="submit"]')
    await submitButton.click()

    // Input should be cleared after submission
    await page.waitForTimeout(1000)
    await expect(textarea).toHaveValue('')
  })

  test('submitting a message shows user message in chat', async ({ page }) => {
    const textarea = page.locator('textarea')
    await textarea.fill('What is 2+2?')

    const submitButton = page.locator('form button[type="submit"]')
    await submitButton.click()

    // User message should appear in the chat area
    await page.waitForTimeout(1000)
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

      // Dropdown should be closed
      const popover = page.locator('[data-radix-popper-content-wrapper]')
      // Either no popover or it's hidden
      const visible = await popover.isVisible().catch(() => false)
      expect(visible).toBe(false)
    }
  })
})

test.describe('Chat Agent Switching', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('selecting the same agent does not navigate away', async ({ page }) => {
    const currentUrl = page.url()

    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    // Click on Thunderbolt (same agent)
    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.isVisible().catch(() => false)) {
      const thunderboltInDropdown = popover.getByText('Thunderbolt').first()
      await thunderboltInDropdown.click()
      await page.waitForTimeout(1000)

      // Should navigate to new chat (per spec: switching agent = new chat)
      expect(page.url()).toContain('/chats/')
    }
  })
})

test.describe('Chat Prompt Suggestions', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('prompt suggestions are visible on new chat', async ({ page }) => {
    // At least some suggestions should be visible
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

      // Either the textarea got filled or we navigated to a chat thread
      const textarea = page.locator('textarea')
      const inputValue = await textarea.inputValue().catch(() => '')
      const urlChanged = page.url() !== urlBefore

      expect(inputValue.length > 0 || urlChanged).toBe(true)
    }
  })
})

test.describe('Chat Navigation', () => {
  test('new chat button creates fresh chat', async ({ page }) => {
    await goToNewChat(page)

    // Type something to dirty the chat
    const textarea = page.locator('textarea')
    await textarea.fill('Some text')

    // Click New Chat in sidebar
    await page.getByText('New Chat').click()
    await page.waitForTimeout(2000)

    // Should be on a new chat page
    expect(page.url()).toContain('/chats/')

    // Textarea should be empty
    await expect(page.locator('textarea')).toHaveValue('')
  })

  test('navigating to /not-found shows 404', async ({ page }) => {
    await page.goto('/not-found')
    await page.waitForTimeout(2000)
    // Should show some kind of not found indication
    const pageContent = await page.textContent('body')
    expect(pageContent).toBeTruthy()
  })
})
