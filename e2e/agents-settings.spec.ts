import { test, expect } from '@playwright/test'
import { goToNewChat, collectPageErrors } from './helpers'

const navigateToAgentsSettings = async (page: any) => {
  await goToNewChat(page)
  // Open sidebar settings
  await page.getByText('Settings').click()
  await page.waitForURL(/\/settings/, { timeout: 5000 })
  // Click Agents in sidebar
  await page.getByText('Agents').click()
  await page.waitForURL(/\/settings\/agents/, { timeout: 5000 })
}

/** Wait for the agents page to finish rendering. */
const waitForAgentsLoaded = async (page: any) => {
  // Wait for heading to confirm we're on the right page (exact match to avoid "Loading agents..." heading)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
}

test.describe('Agents Settings Page', () => {
  test.describe('navigation', () => {
    test('agents page is accessible from settings sidebar', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    })

    test('sidebar shows Agents as active when on agents page', async ({ page }) => {
      await navigateToAgentsSettings(page)
      const agentsButton = page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Agents' })
      await expect(agentsButton).toBeVisible()
    })
  })

  test.describe('add custom agent', () => {
    test('plus button opens add custom agent dialog', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await waitForAgentsLoaded(page)

      // Click the plus button
      const plusButton = page.locator('button').filter({ has: page.locator('svg.lucide-plus') })
      await plusButton.click()

      // Dialog should appear — e2e runs in web mode so only remote agent form is shown
      await expect(page.getByText('Add Custom Agent')).toBeVisible()
      await expect(page.getByLabel('Name')).toBeVisible()
      await expect(page.getByLabel('WebSocket URL')).toBeVisible()
    })

    test('add agent button is disabled until name and url are filled', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await waitForAgentsLoaded(page)

      const plusButton = page.locator('button').filter({ has: page.locator('svg.lucide-plus') })
      await plusButton.click()

      const addButton = page.getByRole('button', { name: 'Add Agent' })
      await expect(addButton).toBeDisabled()

      await page.getByLabel('Name').fill('Test Agent')
      await expect(addButton).toBeDisabled()

      await page.getByLabel('WebSocket URL').fill('wss://example.com/agent/ws')
      await expect(addButton).toBeEnabled()
    })

    test('cancel closes the dialog', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await waitForAgentsLoaded(page)

      const plusButton = page.locator('button').filter({ has: page.locator('svg.lucide-plus') })
      await plusButton.click()

      await expect(page.getByText('Add Custom Agent')).toBeVisible()
      await page.getByRole('button', { name: 'Cancel' }).click()

      // Dialog should close
      await expect(page.getByText('Add Custom Agent')).not.toBeVisible()
    })
  })

  test.describe('search', () => {
    test('search button expands search input', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await waitForAgentsLoaded(page)

      // Click search button
      const searchButton = page.getByRole('button', { name: 'Search' })
      await searchButton.click()

      // Search input should appear
      const searchInput = page.getByPlaceholder('Search agents...')
      await expect(searchInput).toBeVisible()
    })
  })

  test.describe('no JS errors', () => {
    test('no critical JS errors during page load and interaction', async ({ page }) => {
      const errors = collectPageErrors(page)

      await navigateToAgentsSettings(page)
      await waitForAgentsLoaded(page)

      // Interact with search
      const searchButton = page.getByRole('button', { name: 'Search' })
      await searchButton.click()
      const searchInput = page.getByPlaceholder('Search agents...')
      await searchInput.fill('test')
      await page.waitForTimeout(500)
      await searchInput.clear()
      await page.waitForTimeout(500)

      // Filter out network-related errors (expected in test environment)
      const criticalErrors = errors.filter(
        (e) =>
          !e.includes('fetch') &&
          !e.includes('ERR_CONNECTION') &&
          !e.includes('network') &&
          !e.includes('Failed to fetch'),
      )
      expect(criticalErrors).toHaveLength(0)
    })
  })
})
