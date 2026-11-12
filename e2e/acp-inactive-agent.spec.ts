/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page, WebSocketRoute } from '@playwright/test'
import { test, expect } from './test'
import { collectPageErrors, loginViaOidc, sendChatPrompt } from './helpers'

/**
 * A chat left open on a custom agent must stop sending to it once the agent is
 * disabled or deleted in Settings. Everything after login stays in one
 * document: the chat session that holds the agent object survives a client-side
 * navigation, while a reload would rebuild it from the agent rows.
 *
 * The web app reaches a custom agent through the backend relay
 * (`/v1/proxy/ws`), so the mock agent answers on that socket. The add form's
 * connection test dials the agent URL directly, so that host is mocked too.
 */

const agentName = 'Temporary Agent'
const agentUrl = 'wss://temporary-agent.example.test/ws'
const refusal = 'This agent was disabled or deleted. Choose another agent to continue.'

type JsonRpcRequest = { id?: number; method: string; params?: { sessionId?: string } }
type AgentResult =
  | { protocolVersion: 1; agentCapabilities: Record<string, never> }
  | { sessionId: string }
  | { stopReason: 'end_turn' }

/** A minimal ACP agent that counts its handshakes and prompts. */
const mockAgent = async (page: Page) => {
  const seen = { initializes: 0, prompts: 0 }
  const reply = (ws: WebSocketRoute, id: number | undefined, result: AgentResult) =>
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))

  await page.routeWebSocket(agentUrl, (ws) => {
    ws.onMessage((message) => {
      const rpc = JSON.parse(message.toString()) as JsonRpcRequest
      if (rpc.method === 'initialize') {
        reply(ws, rpc.id, { protocolVersion: 1, agentCapabilities: {} })
      }
    })
  })

  await page.routeWebSocket('**/v1/proxy/ws', (ws) => {
    ws.onMessage((message) => {
      const rpc = JSON.parse(message.toString()) as JsonRpcRequest
      if (rpc.method === 'initialize') {
        seen.initializes += 1
        reply(ws, rpc.id, { protocolVersion: 1, agentCapabilities: {} })
      } else if (rpc.method === 'session/new') {
        reply(ws, rpc.id, { sessionId: 'temporary-session' })
      } else if (rpc.method === 'session/prompt') {
        seen.prompts += 1
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: rpc.params?.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `Reply ${seen.prompts}` },
              },
            },
          }),
        )
        reply(ws, rpc.id, { stopReason: 'end_turn' })
      }
    })
  })

  return seen
}

/** Add the agent from the chat's own picker, select it, and get one reply from it. */
const chatWithNewAgent = async (page: Page) => {
  await loginViaOidc(page)

  await page.getByTestId('agent-selector-trigger').click()
  await page.getByText('Add Agent', { exact: true }).click()
  const panel = page
    .getByRole('complementary')
    .filter({ hasText: 'Add Agent' })
    .or(page.getByRole('dialog', { name: 'Add Agent' }))
  await expect(panel).toBeVisible()
  await panel.getByLabel('Name').fill(agentName)
  await panel.getByLabel('URL').fill(agentUrl)
  await panel.getByRole('button', { name: 'Test connection' }).click()
  await expect(panel.getByText('Connection successful!')).toBeVisible()
  await panel.getByRole('button', { name: 'Add agent' }).click()
  await expect(panel).toBeHidden()

  await page.getByTestId('agent-selector-trigger').click()
  await page.getByRole('button', { name: agentName, exact: true }).click()
  await expect(page.getByTestId('agent-selector-trigger')).toContainText(agentName)

  await sendChatPrompt(page, 'First question')
  await expect(page.getByText('Reply 1')).toBeVisible()
  await expect(page).toHaveURL(/\/chats\/[^/]+$/)
}

/** Open the agent's detail panel in Settings without reloading the page. */
const openAgentSettings = async (page: Page) => {
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog', { name: 'Search', exact: true })
  await search.getByRole('combobox').fill('All agents')
  await search.getByRole('option').filter({ hasText: 'All agents' }).first().click()
  await expect(page).toHaveURL(/\/settings\/agents$/)
  await page.getByRole('button', { name: `Open ${agentName}` }).click()
}

/** Go back to the open chat and try to send again. */
const sendAgainFromOpenChat = async (page: Page) => {
  await page.goBack()
  await expect(page).toHaveURL(/\/chats\/[^/]+$/)
  await expect(page.getByText('Reply 1')).toBeVisible()
  await sendChatPrompt(page, 'Second question')
  await expect(page.getByText(refusal)).toBeVisible()
}

test.describe('ACP disabled or deleted agent', () => {
  test('an open chat stops sending to an agent disabled in Settings', async ({ page }) => {
    const errors = collectPageErrors(page)
    const agent = await mockAgent(page)
    await chatWithNewAgent(page)

    await openAgentSettings(page)
    await page.getByRole('switch', { name: `Disable ${agentName}` }).click()
    await expect(page.getByRole('switch', { name: `Enable ${agentName}` })).toBeVisible()

    await sendAgainFromOpenChat(page)
    expect(agent.prompts).toBe(1)
    expect(agent.initializes).toBe(1)
    expect(errors).toHaveLength(0)
  })

  test('an open chat neither sends to nor reconnects an agent deleted in Settings', async ({ page }) => {
    const errors = collectPageErrors(page)
    const agent = await mockAgent(page)
    await chatWithNewAgent(page)

    await openAgentSettings(page)
    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Delete agent' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete agent' }).click()
    await expect(page.getByRole('button', { name: `Open ${agentName}` })).toHaveCount(0)

    await sendAgainFromOpenChat(page)
    expect(agent.prompts).toBe(1)
    expect(agent.initializes).toBe(1)
    expect(errors).toHaveLength(0)
  })
})
