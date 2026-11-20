/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Route } from '@playwright/test'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'
import { expect, test } from './test'

const url = 'http://localhost:18993/v1'
const modelName = 'Slow Local Model'

const completion = {
  id: 'completion',
  object: 'chat.completion',
  created: 0,
  model: 'slow-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

test('a slow local model shows the loading state and then passes the test', async ({ page }) => {
  const errors = collectPageErrors(page)
  const email = await loginViaEmailCode(page)
  const connectionId = crypto.randomUUID()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'slow-model-fixture', email },
    tables: {
      provider_connections: [
        { id: connectionId, provider: 'custom', name: 'Local fixture', authMethod: 'api_key', url, enabled: 1 },
      ],
      provider_connection_secrets: [
        {
          id: connectionId,
          binding: JSON.stringify(['custom', 'api_key', url]),
          credentials: JSON.stringify({ apiKey: 'local-key' }),
        },
      ],
      models: [
        {
          id: crypto.randomUUID(),
          providerConnectionId: connectionId,
          provider: 'custom',
          name: modelName,
          model: 'slow-model',
          enabled: 1,
          isSystem: 0,
          toolUsage: 1,
        },
      ],
    },
  })

  // Hold the completion until the loading state is on screen, like a model still loading into memory.
  const held: Route[] = []
  const holdCompletion = (route: Route) => {
    held.push(route)
  }
  await page.route(`${url}/chat/completions`, holdCompletion)
  await page.route('**/v1/proxy', (route) =>
    route.request().headers()['x-proxy-target-url']?.startsWith(url) ? holdCompletion(route) : route.fallback(),
  )

  await page.goto('/settings/models')
  await page.getByRole('button', { name: `Open ${modelName}`, exact: true }).click()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  await page.getByRole('button', { name: 'Test model', exact: true }).click()

  await expect(page.getByRole('button', { name: 'Testing model…', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Loading model…', exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Local models can take a few minutes to load the first time.')).toBeVisible()

  expect(held.length).toBeGreaterThan(0)
  await Promise.all(held.map((route) => route.fulfill({ json: completion })))

  await expect(page.getByText('Test successful!')).toBeVisible()
  await expect(page.getByText('Local models can take a few minutes to load the first time.')).toBeHidden()
  expect(errors).toEqual([])
})
