/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

/**
 * E2E for backend-driven system agent discovery.
 *
 * On bootstrap (`useBootstrapSystemAgents` in `src/app.tsx`) the app calls
 * `GET {cloudUrl}/agents` once the user has a non-anonymous session. We
 * intercept that call with a synthetic Haystack entry and verify that:
 *
 * 1. The row materialises in `/settings/agents` with the "System" badge.
 * 2. The delete affordance is hidden — system agents are managed by the
 *    backend, not the user.
 *
 * Route registration happens before `page.goto` so the very first bootstrap
 * fetch is intercepted; otherwise the real backend's (empty) response would
 * race with the mock.
 */
test.describe('ACP system agent discovery', () => {
  test('discovered system agent appears with System badge and is not removable', async ({ page }) => {
    const errors = collectPageErrors(page)

    let discoveryHits = 0
    await page.route('**/v1/agents', async (route) => {
      discoveryHits += 1
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1',
          agents: [
            {
              id: 'haystack-rag',
              name: 'RAG Chat',
              type: 'managed-acp',
              transport: 'websocket',
              url: 'wss://test.example/ws',
              description: 'Retrieval-augmented chat',
              icon: null,
              isSystem: 1,
            },
          ],
          allowCustomAgents: true,
        }),
      })
    })

    await loginViaOidc(page)

    await page.goto('/settings/agents')
    await expect(page.getByTestId('agent-list')).toBeVisible({ timeout: 10_000 })

    // The discovery endpoint should have been called at least once during
    // bootstrap. PowerSync's live query then surfaces the upserted row.
    await expect.poll(() => discoveryHits, { timeout: 10_000 }).toBeGreaterThan(0)

    const systemRow = page.getByTestId('agent-row-haystack-rag')
    await expect(systemRow).toBeVisible({ timeout: 10_000 })
    await expect(systemRow.getByTestId('agent-badge-haystack-rag')).toHaveText('System')

    // Delete affordance must be absent for system agents.
    await expect(systemRow.getByTestId('agent-delete-haystack-rag')).toHaveCount(0)

    expect(errors).toHaveLength(0)
  })
})
