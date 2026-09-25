/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelOpus5 } from '../shared/defaults/models'
import { loginViaOidc, sendChatPrompt } from './helpers'
import { expect, test } from './test'

test.slow()

const mcpUrl = 'http://127.0.0.1:9879/mcp'

test('the model calls an MCP tool through the proxy and displays its result', async ({ page }) => {
  const toolCalls: string[] = []
  page.on('request', (request) => {
    if (
      request.url().endsWith('/v1/proxy') &&
      request.headers()['x-proxy-target-url'] === mcpUrl &&
      request.postData()?.includes('"tools/call"')
    ) {
      toolCalls.push(request.postData() ?? '')
    }
  })
  await loginViaOidc(page)
  await page.goto('/settings/connections')
  await page.getByRole('button', { name: 'New Connection' }).click()
  await page.getByPlaceholder('Server name (used to prefix tools)').fill('Nightly Echo')
  await page.getByPlaceholder('http://localhost:8000/mcp/').fill(mcpUrl)
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Connection successful!')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Add Server' }).click()
  await page.goto('/')
  await expect(page.locator('textarea')).toBeVisible()
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus5.name, exact: true }).click()
  const marker = `blue-heron-${crypto.randomUUID().slice(0, 8)}`
  await sendChatPrompt(page, `Use the Nightly Echo echo tool with message "${marker}". Quote its result exactly.`)

  await expect.poll(() => toolCalls.length, { timeout: 90_000 }).toBeGreaterThan(0)
  expect(toolCalls.some((body) => body.includes(marker))).toBe(true)
  await expect(page.locator('.tool-invocation-card')).toBeVisible()
  await page.locator('.tool-invocation-card').getByRole('button').first().click()
  await page.getByRole('button', { name: /Nightly Echo.*echo/i }).click()
  await expect(page.getByText(`Nightly MCP result: ${marker}`, { exact: false })).toBeVisible()
})
