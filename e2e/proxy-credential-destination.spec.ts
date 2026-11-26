/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'
import { importBackup } from './import-backup'
import { expect, test } from './test'

const mcpId = 'e2e-mcp-destination'
const savedMcpUrl = 'https://mcp.example.com/mcp'
const movedMcpUrl = 'https://mcp-moved.example.com/mcp'
const oauthMcpId = 'e2e-mcp-oauth-destination'
const savedOauthMcpUrl = 'https://mcp-oauth.example.com/mcp'
const movedOauthMcpUrl = 'https://mcp-oauth-moved.example.com/mcp'
const modelId = 'e2e-model-destination'
const savedModelUrl = 'https://llm.example.com/v1'
const movedModelUrl = 'https://llm-moved.example.com/v1'

type ProxiedRequest = { target: string; authorization: string | null }

/**
 * Stand in for every upstream behind `/v1/proxy`: a minimal Streamable HTTP MCP
 * server and an OpenAI-compatible chat endpoint. Records where each request went
 * and which upstream credential it carried.
 */
const mockUpstreams = async (page: Page): Promise<ProxiedRequest[]> => {
  const requests: ProxiedRequest[] = []
  await page.route('**/v1/proxy', async (route) => {
    const request = route.request()
    const target = request.headers()['x-proxy-target-url'] ?? ''
    requests.push({ target, authorization: request.headers()['x-proxy-passthrough-authorization'] ?? null })
    if (target.endsWith('/chat/completions')) {
      return route.fulfill({
        json: {
          id: 'completion',
          object: 'chat.completion',
          created: 0,
          model: 'llama',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      })
    }
    if (request.method() !== 'POST') {
      return route.fulfill({ status: 405 })
    }
    const rpc = request.postDataJSON() as { id?: number; method: string }
    if (rpc.id === undefined) {
      return route.fulfill({ status: 202 })
    }
    const result =
      rpc.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'e2e', version: '1.0.0' } }
        : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
    return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result } })
  })
  return requests
}

const backup = (tables: Record<string, unknown[]>) => ({
  format: 'thunderbolt-export',
  schemaVersion: 1,
  exportedAt: '2026-11-10T00:00:00.000Z',
  user: { id: 'e2e', email: null },
  tables,
})

const modelRow = (url: string) => ({
  id: modelId,
  provider: 'custom',
  name: 'Destination Model',
  model: 'llama',
  url,
  enabled: 1,
  toolUsage: 1,
})

const mcpRow = (url: string) => ({ id: mcpId, name: 'Destination MCP', type: 'http', url, enabled: 1 })

const oauthMcpRow = (url: string) => ({
  id: oauthMcpId,
  name: 'Destination OAuth MCP',
  type: 'http',
  url,
  enabled: 1,
})

/** A fresh OAuth authorization saved for `url`, so reconnects never need a refresh. */
const oauthCredentials = (url: string) =>
  JSON.stringify({
    type: 'oauth',
    access_token: 'saved-oauth-token',
    expires_at: Date.now() + 24 * 60 * 60 * 1000,
    approvedUrl: url,
  })

/** The distinct upstream credentials sent to targets under `url`. */
const credentialsSentTo = (requests: ProxiedRequest[], url: string) => [
  ...new Set(requests.filter(({ target }) => target.startsWith(url)).map(({ authorization }) => authorization)),
]

const requestCountTo = (requests: ProxiedRequest[], url: string) =>
  requests.filter(({ target }) => target.startsWith(url)).length

const openEditPanel = async (page: Page, path: string, name: string) => {
  await page.goto(path)
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
}

test('a saved MCP credential is only sent to the URL it was saved for', async ({ page }) => {
  const errors = collectPageErrors(page)
  const requests = await mockUpstreams(page)
  await loginViaOidc(page)
  await importBackup(
    page,
    backup({
      mcp_servers: [mcpRow(savedMcpUrl), oauthMcpRow(savedOauthMcpUrl)],
      mcp_secrets: [
        { id: mcpId, credentials: JSON.stringify({ type: 'bearer', token: 'saved-token', approvedUrl: savedMcpUrl }) },
        { id: oauthMcpId, credentials: oauthCredentials(savedOauthMcpUrl) },
      ],
    }),
  )

  // The saved MCP URL still authenticates.
  await expect.poll(() => requestCountTo(requests, savedMcpUrl), { timeout: 30_000 }).toBeGreaterThan(0)
  expect(credentialsSentTo(requests, savedMcpUrl)).toEqual(['Bearer saved-token'])

  // Editing the MCP URL: the saved credential is offered while the URL is unchanged, and the
  // automatic probe that runs before Save must leave it behind once the URL moves.
  await openEditPanel(page, '/settings/connections', 'Destination MCP')
  await expect(page.getByRole('button', { name: 'Clear saved credential' })).toBeVisible()
  await page.getByPlaceholder('http://localhost:8000/mcp/').fill(movedMcpUrl)
  await expect(page.getByText('The saved credential is only sent to the URL it was saved for.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear saved credential' })).toBeHidden()
  await expect.poll(() => requestCountTo(requests, movedMcpUrl), { timeout: 30_000 }).toBeGreaterThan(0)
  expect(credentialsSentTo(requests, movedMcpUrl)).toEqual([null])
  await page.getByRole('button', { name: 'Cancel' }).click()

  // A saved OAuth authorization is also left behind, and the form says to authorize again.
  await openEditPanel(page, '/settings/connections', 'Destination OAuth MCP')
  await page.getByPlaceholder('http://localhost:8000/mcp/').fill(movedOauthMcpUrl)
  await expect(page.getByText('The saved authorization only works with the previous URL.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // A backup that moves the MCP id elsewhere and omits its secret.
  const movedMcpRequests = requestCountTo(requests, movedMcpUrl)
  await importBackup(page, backup({ mcp_servers: [mcpRow(movedMcpUrl)] }))

  // The reconnect goes to the new URL unauthenticated.
  await page.goto('/settings/connections')
  await expect.poll(() => requestCountTo(requests, movedMcpUrl), { timeout: 30_000 }).toBeGreaterThan(movedMcpRequests)
  expect(credentialsSentTo(requests, movedMcpUrl)).toEqual([null])
  expect(errors).toHaveLength(0)
})

// A custom model with a URL is turned into a provider connection the first time the app starts
// after the import, so these two tests exercise the saved key through that upgrade.
test('a saved model key still authenticates the URL it was saved for', async ({ page }) => {
  const errors = collectPageErrors(page)
  const requests = await mockUpstreams(page)
  await loginViaOidc(page)
  await importBackup(
    page,
    backup({
      models: [modelRow(savedModelUrl)],
      models_secrets: [{ modelId, apiKey: 'sk-saved', provider: 'custom', url: savedModelUrl }],
    }),
  )

  await openEditPanel(page, '/settings/models', 'Destination Model')
  await page.getByRole('button', { name: 'Test model' }).click()
  await expect.poll(() => requestCountTo(requests, savedModelUrl), { timeout: 30_000 }).toBeGreaterThan(0)
  expect(credentialsSentTo(requests, savedModelUrl)).toEqual(['Bearer sk-saved'])
  expect(errors).toHaveLength(0)
})

test('a model key saved for another URL is not carried to the model’s URL', async ({ page }) => {
  const errors = collectPageErrors(page)
  const requests = await mockUpstreams(page)
  await loginViaOidc(page)
  // The model row points at the moved URL while the local key is still bound to the saved one.
  await importBackup(
    page,
    backup({
      models: [modelRow(movedModelUrl)],
      models_secrets: [{ modelId, apiKey: 'sk-saved', provider: 'custom', url: savedModelUrl }],
    }),
  )

  await openEditPanel(page, '/settings/models', 'Destination Model')
  await page.getByRole('button', { name: 'Test model' }).click()
  await expect.poll(() => requestCountTo(requests, movedModelUrl), { timeout: 30_000 }).toBeGreaterThan(0)
  expect(credentialsSentTo(requests, movedModelUrl)).toEqual([null])
  expect(credentialsSentTo(requests, savedModelUrl)).toEqual([])
  expect(errors).toHaveLength(0)
})
