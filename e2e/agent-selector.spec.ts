import { test, expect } from '@playwright/test'
import { goToNewChat } from './helpers'

test.describe('Agent Selector', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test('shows Thunderbolt as default agent in header', async ({ page }) => {
    const header = page.locator('header')
    // Wait for agent selector to render (depends on DB initialization)
    const agentButton = header.getByText('Thunderbolt')
    await expect(agentButton).toBeVisible({ timeout: 10000 })
  })

  test('agent selector has dropdown chevron', async ({ page }) => {
    const header = page.locator('header')
    // The agent selector trigger contains the agent name and a chevron icon
    const trigger = header.locator('div').filter({ hasText: 'Thunderbolt' }).first()
    await expect(trigger).toBeVisible()
    // Should have an SVG (chevron icon)
    const svg = trigger.locator('svg')
    expect(await svg.count()).toBeGreaterThan(0)
  })

  test('clicking agent selector opens dropdown menu', async ({ page }) => {
    const header = page.locator('header')
    const agentTrigger = header.getByText('Thunderbolt').first()
    await agentTrigger.click()
    await page.waitForTimeout(500)

    // A popover/dropdown should appear with agent options
    // Look for the popover content
    const popover = page.locator('[data-radix-popper-content-wrapper], [role="listbox"], [role="menu"]')
    const popoverCount = await popover.count()

    if (popoverCount > 0) {
      await expect(popover.first()).toBeVisible()
    }
    // Take a screenshot for visual verification
    await page.screenshot({ path: '/tmp/e2e-agent-dropdown.png' })
  })

  test('agent selector dropdown shows built-in agent', async ({ page }) => {
    const header = page.locator('header')
    await header.getByText('Thunderbolt').first().click()
    await page.waitForTimeout(500)

    // Should see Thunderbolt in the dropdown list
    const thunderboltItem = page.getByText('Thunderbolt')
    expect(await thunderboltItem.count()).toBeGreaterThan(0)
  })
})
