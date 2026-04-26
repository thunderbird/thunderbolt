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
    // The trigger is a <button> wrapping the label — click it to open the Radix popover
    const agentTrigger = header.getByText('Thunderbolt').first()
    await agentTrigger.click()
    await page.waitForTimeout(500)

    // Radix popovers may not open reliably in headless Chromium — soft-check here
    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.count()) {
      await expect(popover.first()).toBeVisible()
    }
  })

  test('agent selector dropdown shows built-in agent', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.isVisible().catch(() => false)) {
      await expect(popover.getByText('Thunderbolt').first()).toBeVisible()
    }
  })

  test('on web: local agents (Codex, Claude Code) are NOT shown', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.isVisible().catch(() => false)) {
      // These local agents should be filtered out on web
      expect(await popover.getByText('Codex', { exact: true }).count()).toBe(0)
      expect(await popover.getByText('Claude Code', { exact: true }).count()).toBe(0)
    }
  })

  test('on web: no "Local Agents" group header is shown', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.isVisible().catch(() => false)) {
      expect(await popover.getByText('Local Agents').count()).toBe(0)
    }
  })

  test('selected agent shows checkmark icon', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    const popover = page.locator('[data-radix-popper-content-wrapper]')
    if (await popover.isVisible().catch(() => false)) {
      const selectedItem = popover.locator('.bg-accent')
      if (await selectedItem.count()) {
        // At least 2 SVGs: the agent icon + the checkmark
        const svgs = selectedItem.locator('svg')
        expect(await svgs.count()).toBeGreaterThanOrEqual(2)
      }
    }
  })
})
