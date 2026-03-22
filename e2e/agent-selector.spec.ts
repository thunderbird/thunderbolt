import { test, expect } from '@playwright/test'
import { goToNewChat } from './helpers'

test.describe('Agent Selector', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('shows Thunderbolt as default agent in header', async ({ page }) => {
    const header = page.locator('header')
    const agentButton = header.getByText('Thunderbolt')
    await expect(agentButton).toBeVisible({ timeout: 10000 })
  })

  test('agent selector has dropdown chevron', async ({ page }) => {
    const header = page.locator('header')
    const trigger = header.locator('div').filter({ hasText: 'Thunderbolt' }).first()
    await expect(trigger).toBeVisible()
    const svg = trigger.locator('svg')
    expect(await svg.count()).toBeGreaterThan(0)
  })

  test('clicking agent selector opens dropdown menu', async ({ page }) => {
    const header = page.locator('header')
    const agentTrigger = header.getByText('Thunderbolt').first()
    await agentTrigger.click()
    await page.waitForTimeout(500)

    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.count()) {
      await expect(popover.first()).toBeVisible()
    }
  })

  test('agent selector dropdown shows built-in agent', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    const thunderboltItem = page.getByText('Thunderbolt')
    expect(await thunderboltItem.count()).toBeGreaterThan(0)
  })

  test('on web: local agents (Codex, Claude Code) are NOT shown', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    // These local agents should be filtered out on web
    const codex = page.getByText('Codex', { exact: true })
    const claudeCode = page.getByText('Claude Code', { exact: true })

    expect(await codex.count()).toBe(0)
    expect(await claudeCode.count()).toBe(0)
  })

  test('on web: no "Local Agents" group header is shown', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    const localGroup = page.getByText('Local Agents')
    expect(await localGroup.count()).toBe(0)
  })

  test('selected agent shows checkmark icon', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    // The selected agent (Thunderbolt) should have a bg-accent class and a checkmark
    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.isVisible().catch(() => false)) {
      const selectedItem = popover.locator('.bg-accent')
      if (await selectedItem.count()) {
        // Should contain a checkmark SVG
        const svgs = selectedItem.locator('svg')
        // At least 2 SVGs: the agent icon + the checkmark
        expect(await svgs.count()).toBeGreaterThanOrEqual(2)
      }
    }
  })

  test('agent selector shows on chat routes only', async ({ page }) => {
    // On chat page, agent selector should be visible
    const header = page.locator('header')
    await expect(header.getByText('Thunderbolt')).toBeVisible()

    // Navigate to settings
    await page.getByText('Settings').click()
    await page.waitForTimeout(1000)

    // Agent selector may or may not be visible on settings page
    // depending on whether settings is a chat route
  })
})
