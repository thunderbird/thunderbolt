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

test.describe('Agents Settings Page', () => {
  test.describe('navigation', () => {
    test('agents page is accessible from settings sidebar', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
    })

    test('sidebar shows Agents as active when on agents page', async ({ page }) => {
      await navigateToAgentsSettings(page)
      const agentsButton = page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Agents' })
      await expect(agentsButton).toBeVisible()
    })
  })

  test.describe('agent list rendering', () => {
    test('shows agent cards after loading', async ({ page }) => {
      await navigateToAgentsSettings(page)
      // Wait for registry to load — at least one agent card should appear
      const firstCard = page.locator('[class*="border-border"]').first()
      await expect(firstCard).toBeVisible({ timeout: 10000 })
    })

    test('shows agent names from the ACP registry', async ({ page }) => {
      await navigateToAgentsSettings(page)
      // These are well-known agents that should be in the registry
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })
    })

    test('shows distribution type badges', async ({ page }) => {
      await navigateToAgentsSettings(page)
      // Wait for cards to load
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })
      // Should show Node.js badge for NPX agents
      await expect(page.getByText('Node.js').first()).toBeVisible()
    })

    test('shows agent descriptions', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })
      // Agents should have some description text below their name
      const descriptions = page.locator('.line-clamp-2')
      const count = await descriptions.count()
      expect(count).toBeGreaterThan(0)
    })

    test('shows version badges', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })
      // Should show version like "v0.24.2"
      const versionBadge = page.locator('text=/^v\\d+\\.\\d+/')
      await expect(versionBadge.first()).toBeVisible()
    })
  })

  test.describe('search', () => {
    test('search button expands search input', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })

      // Click search button
      const searchButton = page.getByRole('button', { name: 'Search' })
      await searchButton.click()

      // Search input should appear
      const searchInput = page.getByPlaceholder('Search agents...')
      await expect(searchInput).toBeVisible()
    })

    test('search filters agents by name', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })

      // Open search and type
      const searchButton = page.getByRole('button', { name: 'Search' })
      await searchButton.click()
      const searchInput = page.getByPlaceholder('Search agents...')
      await searchInput.fill('Claude')

      // Claude should be visible, others should be filtered out
      await expect(page.getByText('Claude Agent')).toBeVisible()
      // Wait for filter to apply
      await page.waitForTimeout(200)
      // goose should not be visible (filtered out)
      await expect(page.getByText('goose')).not.toBeVisible()
    })

    test('search shows no results message when nothing matches', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })

      const searchButton = page.getByRole('button', { name: 'Search' })
      await searchButton.click()
      const searchInput = page.getByPlaceholder('Search agents...')
      await searchInput.fill('zzzznonexistent')

      await expect(page.getByText('No agents match your search')).toBeVisible()
    })
  })

  test.describe('install button', () => {
    test('uninstalled agents show Install button', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })
      const installButtons = page.getByRole('button', { name: 'Install' })
      const count = await installButtons.count()
      expect(count).toBeGreaterThan(0)
    })
  })

  test.describe('add custom agent', () => {
    test('plus button opens add custom agent dialog', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })

      // Click the plus button
      const plusButton = page.locator('button').filter({ has: page.locator('svg.lucide-plus') })
      await plusButton.click()

      // Dialog should appear
      await expect(page.getByText('Add Custom Agent')).toBeVisible()
      await expect(page.getByLabel('Name')).toBeVisible()
      await expect(page.getByLabel('Command')).toBeVisible()
    })

    test('add agent button is disabled until name and command are filled', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })

      const plusButton = page.locator('button').filter({ has: page.locator('svg.lucide-plus') })
      await plusButton.click()

      const addButton = page.getByRole('button', { name: 'Add Agent' })
      await expect(addButton).toBeDisabled()

      await page.getByLabel('Name').fill('Test Agent')
      await expect(addButton).toBeDisabled()

      await page.getByLabel('Command').fill('/usr/bin/test')
      await expect(addButton).toBeEnabled()
    })

    test('cancel closes the dialog', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })

      const plusButton = page.locator('button').filter({ has: page.locator('svg.lucide-plus') })
      await plusButton.click()

      await expect(page.getByText('Add Custom Agent')).toBeVisible()
      await page.getByRole('button', { name: 'Cancel' }).click()

      // Dialog should close
      await expect(page.getByText('Add Custom Agent')).not.toBeVisible()
    })
  })

  test.describe('platform gating (web)', () => {
    test('local agent Install buttons are disabled on web', async ({ page }) => {
      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })

      // On web, local agent Install buttons should be disabled
      const disabledButtons = page.locator('button:has-text("Install"):disabled')
      const count = await disabledButtons.count()
      expect(count).toBeGreaterThan(0)
    })
  })

  test.describe('no JS errors', () => {
    test('no critical JS errors during page load and interaction', async ({ page }) => {
      const errors = collectPageErrors(page)

      await navigateToAgentsSettings(page)
      await expect(page.getByText('Claude Agent')).toBeVisible({ timeout: 10000 })

      // Interact with search
      const searchButton = page.getByRole('button', { name: 'Search' })
      await searchButton.click()
      const searchInput = page.getByPlaceholder('Search agents...')
      await searchInput.fill('Claude')
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
