/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { importBackup } from './import-backup'

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`standalone agents at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('edits and removes an imported agent without signing in', async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem(
          'thunderbolt-local-settings',
          JSON.stringify({ state: { cloudUrl: '', localMode: true, serverHasAuthenticated: false }, version: 0 }),
        )
      })
      await importBackup(page, {
        format: 'thunderbolt-export',
        schemaVersion: 1,
        tables: {
          agents: [
            {
              id: 'imported-local-agent',
              name: 'Imported local agent',
              type: 'remote-acp',
              transport: 'websocket',
              url: 'wss://local-agent.example/ws',
              userId: 'original-owner',
            },
          ],
        },
      })
      await page.goto('/settings/agents')
      await page.getByRole('button', { name: 'Open Imported local agent', exact: true }).click()
      await page.getByLabel('Name', { exact: true }).fill('Renamed imported agent')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Renamed imported agent', exact: true })).toBeVisible()

      await page.reload()
      await page.getByRole('button', { name: 'Open Renamed imported agent', exact: true }).click()
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Delete agent', exact: true }).click()
      await page.getByRole('button', { name: 'Delete agent', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Open Renamed imported agent', exact: true })).toHaveCount(0)
    })

    test('adds, edits, and removes a custom agent without signing in', async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem(
          'thunderbolt-local-settings',
          JSON.stringify({ state: { cloudUrl: '', localMode: true, serverHasAuthenticated: false }, version: 0 }),
        )
      })
      await page.routeWebSocket('wss://local-agent.example/ws', (socket) => {
        socket.onMessage((message) => {
          const request = JSON.parse(String(message)) as { id?: number; method?: string }
          if (request.method === 'initialize') {
            socket.send(
              JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } }),
            )
          }
        })
      })

      await page.goto('/settings/agents')
      const add = page.getByRole('button', { name: 'New Agent', exact: true })
      await expect(add).toBeEnabled()
      await add.click()
      await page.getByLabel('Name', { exact: true }).fill('Local test agent')
      await page.getByLabel('URL', { exact: true }).fill('wss://local-agent.example/ws')
      await page.getByRole('button', { name: 'Test connection', exact: true }).click()
      await page.getByRole('button', { name: 'Add Agent', exact: true }).click()

      await page.getByRole('button', { name: 'Open Local test agent', exact: true }).click()
      await page.getByLabel('Name', { exact: true }).fill('Renamed local agent')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Renamed local agent', exact: true })).toBeVisible()

      await page.reload()
      await page.getByRole('button', { name: 'Open Renamed local agent', exact: true }).click()
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Delete agent', exact: true }).click()
      await page.getByRole('button', { name: 'Delete agent', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Open Renamed local agent', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Open Thunderbolt', exact: true })).toBeVisible()
    })
  })
}
