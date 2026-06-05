/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

/**
 * E2E for the "Add Custom Agent" CRUD path on `/settings/agents`.
 *
 * Since #933, "Add Agent" is gated behind a successful "Test Connection": the
 * dialog opens a WebSocket to the entered URL and runs the ACP `initialize`
 * handshake. CI can't reach a real agent, so we mock the WebSocket (Playwright
 * `routeWebSocket`) and answer `initialize` with a minimal valid result — this
 * exercises the real `testAcpConnection` path without an upstream. The contract
 * under test: dialog → connection test → DAL insert → PowerSync live query → UI
 * row.
 */
test.describe('ACP add custom agent', () => {
  test('submitting the dialog persists a new row to the list', async ({ page }) => {
    const errors = collectPageErrors(page)

    // Mock the ACP endpoint: accept the socket and answer the JSON-RPC
    // `initialize` request so the dialog's connection test succeeds. ACP frames
    // one JSON-RPC object per WS message (see src/acp/transports/websocket.ts).
    await page.routeWebSocket(/invalid\.example\.test/, (ws) => {
      ws.onMessage((message) => {
        const rpc = JSON.parse(typeof message === 'string' ? message : message.toString())
        if (rpc.method === 'initialize') {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            }),
          )
        }
      })
    })

    await loginViaOidc(page)

    await page.goto('/settings/agents')
    await expect(page.getByTestId('agent-list')).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Add Custom Agent' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await page.getByLabel('Name').fill('Test Agent')
    await page.getByLabel('URL').fill('wss://invalid.example.test/ws')
    await page.getByLabel('Description').fill('Test description')

    // Add Agent is gated behind a successful connection test (#933): run it and
    // wait for the success state before submitting.
    await dialog.getByRole('button', { name: 'Test Connection' }).click()
    await expect(dialog.getByText('Connection successful!')).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Add Agent' }).click()

    // Dialog dismisses on success — if validation rejected the URL the dialog
    // would stay open with an inline error.
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    // The new row is rendered by name. PowerSync's live query feeds the list
    // from the synced `agents` table so the row should appear without a manual
    // reload.
    await expect(page.getByText('Test Agent')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Test description')).toBeVisible()

    expect(errors).toHaveLength(0)
  })
})
