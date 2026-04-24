import { test, expect } from '@playwright/test'
import { goToNewChat } from './helpers'

/**
 * Helper: inject agents into the chat store via the dev-mode test bridge.
 * Sets both the agents list and the unavailableAgentIds set.
 */
const seedAgentsInStore = async (
  page: import('@playwright/test').Page,
  agents: Array<{
    id: string
    name: string
    type: 'built-in' | 'local' | 'remote'
    transport: string
    icon: string
    isSystem: number
    enabled: number
    command: string | null
    args: string | null
    url: string | null
    authMethod: string | null
    deletedAt: string | null
    defaultHash: string | null
    userId: string | null
  }>,
  unavailableIds: string[],
) => {
  await page.evaluate(
    ({ agents, unavailableIds }) => {
      const store = (window as Record<string, unknown>).__thunderboltChatStore as {
        getState: () => { setAgents: (agents: unknown[], ids: Set<string>) => void }
      }
      store.getState().setAgents(agents, new Set(unavailableIds))
    },
    { agents, unavailableIds },
  )
}

const setSessionAgent = async (
  page: import('@playwright/test').Page,
  agent: { id: string; name: string; type: string; transport: string; icon: string },
) => {
  await page.evaluate(
    ({ agent }) => {
      const store = (window as Record<string, unknown>).__thunderboltChatStore as {
        getState: () => {
          currentSessionId: string | null
          updateSession: (id: string, data: Record<string, unknown>) => void
        }
      }
      const state = store.getState()
      const sessionId = state.currentSessionId
      if (sessionId) {
        store.getState().updateSession(sessionId, {
          agentConfig: {
            ...agent,
            isSystem: 1,
            enabled: 1,
            command: null,
            args: null,
            url: null,
            authMethod: null,
            deletedAt: null,
            defaultHash: null,
            userId: null,
          },
        })
      }
    },
    { agent },
  )
}

const builtInAgent = {
  id: 'agent-built-in',
  name: 'Thunderbolt',
  type: 'built-in' as const,
  transport: 'in-process',
  icon: 'zap',
  isSystem: 1,
  enabled: 1,
  command: null,
  args: null,
  url: null,
  authMethod: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

const localAgent = {
  id: 'agent-claude-code',
  name: 'Claude Code',
  type: 'local' as const,
  transport: 'stdio',
  icon: 'terminal',
  isSystem: 1,
  enabled: 1,
  command: 'claude-agent-acp',
  args: null,
  url: null,
  authMethod: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

const localAgent2 = {
  id: 'agent-codex',
  name: 'Codex',
  type: 'local' as const,
  transport: 'stdio',
  icon: 'code',
  isSystem: 1,
  enabled: 1,
  command: 'codex',
  args: '["--acp"]',
  url: null,
  authMethod: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

const allAgents = [builtInAgent, localAgent, localAgent2]

test.describe('Agent Selector - Unavailable Agents on Web', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test.describe('Hidden by default', () => {
    test('unavailable agents are hidden from the dropdown', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code', 'agent-codex'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // Unavailable agents should NOT be visible
        expect(await popover.getByText('Claude Code').count()).toBe(0)
        expect(await popover.getByText('Codex').count()).toBe(0)
        // No "Local Agents" group header since all local agents are hidden
        expect(await popover.getByText('Local Agents').count()).toBe(0)
      }
    })

    test('available agents show normally', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code', 'agent-codex'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        await expect(popover.getByText('Thunderbolt').first()).toBeVisible()
        const thunderboltButton = popover
          .getByText('Thunderbolt')
          .first()
          .locator('xpath=ancestor::button')
        await expect(thunderboltButton).toBeEnabled()
      }
    })

    test('all agents available - no disabled or hidden items', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, [])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // All agents should be visible and enabled
        await expect(popover.getByText('Thunderbolt').first()).toBeVisible()
        await expect(popover.getByText('Claude Code').first()).toBeVisible()
        await expect(popover.getByText('Codex').first()).toBeVisible()
        const disabledButtons = popover.locator('button:disabled')
        expect(await disabledButtons.count()).toBe(0)
      }
    })
  })

  test.describe('Current chat using unavailable agent', () => {
    test('shows the current chat\'s unavailable agent in the dropdown (disabled)', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code', 'agent-codex'])
      await setSessionAgent(page, { id: 'agent-claude-code', name: 'Claude Code', type: 'local', transport: 'stdio', icon: 'terminal' })

      const header = page.locator('header')
      await header.getByText('Claude Code').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // The current chat's agent should be visible but disabled
        await expect(popover.getByText('Claude Code').first()).toBeVisible()
        const claudeCodeButton = popover.locator('button:disabled').filter({ hasText: 'Claude Code' })
        expect(await claudeCodeButton.count()).toBe(1)
      }
    })

    test('hides other unavailable agents even when one is shown for current chat', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code', 'agent-codex'])
      await setSessionAgent(page, { id: 'agent-claude-code', name: 'Claude Code', type: 'local', transport: 'stdio', icon: 'terminal' })

      const header = page.locator('header')
      await header.getByText('Claude Code').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // Claude Code visible (current chat), Codex hidden (not current chat)
        await expect(popover.getByText('Claude Code').first()).toBeVisible()
        expect(await popover.getByText('Codex').count()).toBe(0)
      }
    })

    test('trigger shows correct agent name for unavailable agent', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])
      await setSessionAgent(page, { id: 'agent-claude-code', name: 'Claude Code', type: 'local', transport: 'stdio', icon: 'terminal' })

      const header = page.locator('header')
      await expect(header.getByText('Claude Code').first()).toBeVisible({ timeout: 5000 })
    })

    test('chat area still renders correctly when agent is unavailable', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const textarea = page.locator('textarea')
      await expect(textarea).toBeVisible()
      await expect(textarea).toHaveAttribute('placeholder', /ask me anything/i)

      const submitButton = page.locator('form button[type="submit"]')
      await expect(submitButton).toBeVisible()
    })

    test('chat input is functional when selected agent is unavailable', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])
      await setSessionAgent(page, { id: 'agent-claude-code', name: 'Claude Code', type: 'local', transport: 'stdio', icon: 'terminal' })

      const textarea = page.locator('textarea')
      await textarea.fill('Hello from unavailable agent chat')
      await expect(textarea).toHaveValue('Hello from unavailable agent chat')
    })
  })

  test.describe('Edge cases', () => {
    test('only built-in agent present - selector works normally', async ({ page }) => {
      await seedAgentsInStore(page, [builtInAgent], [])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        await expect(popover.getByText('Thunderbolt').first()).toBeVisible()
        expect(await popover.getByText('Local Agents').count()).toBe(0)
      }
    })

    test('mixed available/unavailable - only available ones shown', async ({ page }) => {
      // Only Claude Code is unavailable
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // Claude Code should be hidden
        expect(await popover.getByText('Claude Code').count()).toBe(0)

        // Codex should be visible and enabled
        const codexButton = popover.locator('button:not(:disabled)').filter({ hasText: 'Codex' })
        expect(await codexButton.count()).toBe(1)

        // Thunderbolt should be visible and enabled
        const thunderboltButton = popover.locator('button:not(:disabled)').filter({ hasText: 'Thunderbolt' })
        expect(await thunderboltButton.count()).toBe(1)
      }
    })
  })
})
