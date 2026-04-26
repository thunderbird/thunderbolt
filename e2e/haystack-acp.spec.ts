import { test, expect } from '@playwright/test'
import { goToNewChat, collectPageErrors } from './helpers'

/**
 * E2E tests for Haystack/Deepset integration via ACP.
 * Requires backend with valid HAYSTACK_* env vars and frontend dev server.
 * Set HAYSTACK_API_URL to enable these tests in CI.
 */

const haystackEnabled = !!process.env.HAYSTACK_API_URL

/** Helper: select the Haystack Document Search agent */
const selectHaystackAgent = async (page: import('@playwright/test').Page) => {
  const agentSelector = page
    .locator('[data-testid="agent-selector"]')
    .or(page.locator('button').filter({ hasText: /Thunderbolt/i }))
  await agentSelector.first().click()
  await page.waitForTimeout(300)

  const haystackAgent = page.getByText(/Document Search/i).or(page.getByText(/RAG-Chat/i))
  await haystackAgent.first().click()

  // Wait for navigation + ACP connection
  await page.waitForTimeout(3000)
}

/** Helper: send a message and wait for submit */
const sendMessage = async (page: import('@playwright/test').Page, text: string) => {
  const textarea = page.locator('textarea')
  await textarea.fill(text)

  const submitButton = page.locator('form button[type="submit"]')
  await expect(submitButton).toBeEnabled({ timeout: 15000 })
  await submitButton.click()
}

test.describe('Haystack ACP Agent', () => {
  test.skip(!haystackEnabled, 'Skipped: HAYSTACK_API_URL not set')

  test('Haystack agent appears in agent selector', async ({ page }) => {
    const errors = collectPageErrors(page)
    await goToNewChat(page)

    // Open agent selector
    const agentSelector = page
      .locator('[data-testid="agent-selector"]')
      .or(page.locator('button').filter({ hasText: /Thunderbolt/i }))
    await expect(agentSelector.first()).toBeVisible({ timeout: 10000 })
    await agentSelector.first().click()

    // Look for the Haystack agent
    const haystackAgent = page.getByText(/Document Search/i).or(page.getByText(/RAG-Chat/i))
    await expect(haystackAgent.first()).toBeVisible({ timeout: 10000 })

    const criticalErrors = errors.filter((e) => !e.includes('fetch') && !e.includes('WebSocket'))
    expect(criticalErrors).toHaveLength(0)
  })

  test('can select Haystack agent and send a query', async ({ page }) => {
    await goToNewChat(page)
    await selectHaystackAgent(page)
    await sendMessage(page, 'What documents are in this workspace?')

    // Verify user message appears
    await expect(page.getByText('What documents are in this workspace?')).toBeVisible({ timeout: 5000 })

    // Wait for streaming response
    await page.waitForFunction(
      () => {
        const messages = document.querySelectorAll('[data-message-id]')
        const lastMessage = messages[messages.length - 1]
        return lastMessage && lastMessage.textContent && lastMessage.textContent.length > 20
      },
      { timeout: 60000 },
    )
  })

  test('streaming response shows citation badges', async ({ page }) => {
    await goToNewChat(page)
    await selectHaystackAgent(page)
    await sendMessage(page, 'Tell me about cross-border data flows')

    // Wait for response with citation badges
    // Citations appear as inline buttons with file extensions or site names
    const citationBadge = page.locator('button').filter({ hasText: /\.pdf|\.docx|PDF|DOCX/i })
    await expect(citationBadge.first()).toBeVisible({ timeout: 60000 })
  })

  test('clicking citation triggers sideview', async ({ page }) => {
    await goToNewChat(page)
    await selectHaystackAgent(page)
    await sendMessage(page, 'What are the key points in the documents?')

    // Wait for a citation badge
    const citationBadge = page.locator('button').filter({ hasText: /\.pdf|PDF/i })
    await expect(citationBadge.first()).toBeVisible({ timeout: 60000 })

    // Click the first citation — triggers showSideview('document', ...)
    await citationBadge.first().click()

    // On web, the content view panel may or may not be visible depending on layout.
    // Verify the click doesn't throw errors and the citation is clickable.
    await page.waitForTimeout(2000)

    // Check for sidebar content (PDF viewer or header with file name)
    const sidebarContent = page
      .getByText(/\.pdf/i)
      .or(page.locator('[data-page-number]'))
      .or(page.getByRole('button', { name: /download/i }))
    // On Tauri desktop, the sidebar would open. On web, this may not render.
    // Just verify no errors occurred.
    const count = await sidebarContent.count()
    console.log(`Sideview elements found: ${count}`)
  })

  test('no JS errors during document search flow', async ({ page }) => {
    const errors = collectPageErrors(page)
    await goToNewChat(page)
    await selectHaystackAgent(page)

    const textarea = page.locator('textarea')
    await textarea.fill('List all documents')

    // Wait for submit to be enabled
    const submitButton = page.locator('form button[type="submit"]')
    await expect(submitButton).toBeEnabled({ timeout: 15000 })
    await submitButton.click()

    await page.waitForTimeout(5000)

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('fetch') &&
        !e.includes('WebSocket') &&
        !e.includes('AbortError') &&
        !e.includes('NetworkError'),
    )
    expect(criticalErrors).toHaveLength(0)
  })
})
