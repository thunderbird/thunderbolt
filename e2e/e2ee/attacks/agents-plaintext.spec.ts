/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-870 — the `agents` table syncs user content in plaintext (C1, adversary
 * A1, High). **Claim: every user-authored text column on a synced table must be
 * encrypted at rest on the server.**
 *
 * `agents` is synced (shared/powersync-tables.ts) but absent from
 * `encryptedColumnsMap` (shared/e2ee-types.ts:71-99), and the upload encoder only
 * encrypts mapped columns. So on a fully E2EE account, a user-created custom
 * agent's `name` / `url` / `description` land in Postgres in cleartext — zero
 * adversary action, the server just reads them. (`url` is an endpoint, not a
 * bearer secret — credentials live in the local-only `agents_secrets` — which
 * keeps it High, not Critical.)
 *
 * The gap is invisible to the existing C1 oracle because `scanServerForPlaintext`
 * only scans MAPPED columns, so an unmapped synced table is never looked at —
 * which is exactly why this drift shipped. This spec therefore reads the
 * `agents` row directly rather than through that blind oracle.
 *
 * Capability audit: no adversary action at all. The client itself uploads the
 * plaintext; a passive server (A1/A2) simply stores and reads it.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — the
 * agent's `name` is stored as `__enc:` ciphertext — and is tagged `test.fail()`
 * because the vuln is open today, so that assertion fails now (the value is
 * cleartext). When THU-870 is fixed (add `agents: ['name','url','description']`
 * to the map via the two-PR sync-rule flow), the value is encrypted, the
 * assertion passes, and Playwright flags the unexpected pass → drop the
 * `test.fail()` tag for a permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/agents-plaintext.spec.ts
 */

import { expect, test } from '../fixtures'
import { waitForAgentRow, waitForUserId } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, loginViaConsumerOtp } from '../helpers'

test.describe.serial('THU-870 — agents plaintext', () => {
  test('a custom agent syncs its name to the server in cleartext despite E2EE', async ({ page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()
    const nameMarker = `agent-name-${crypto.randomUUID()}`
    const descriptionMarker = `agent-desc-${crypto.randomUUID()}`

    // Mock the ACP endpoint so the form's connection test succeeds without an
    // upstream (mirrors e2e/acp-add-custom-agent.spec.ts).
    await page.routeWebSocket(/invalid\.example\.test/, (ws) => {
      ws.onMessage((message) => {
        const rpc = JSON.parse(typeof message === 'string' ? message : message.toString())
        if (rpc.method === 'initialize') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: 1, agentCapabilities: {} } }))
        }
      })
    })

    // Full E2EE account — the promise here is that the server cannot read content.
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    // Create a custom agent with marked user content.
    await page.goto('/settings/agents')
    await expect(page.getByTestId('agent-list')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'New Agent' }).click()
    const panel = page.getByRole('complementary').filter({ hasText: 'Add Agent' })
    await expect(panel).toBeVisible()
    await page.getByLabel('Name').fill(nameMarker)
    await page.getByLabel('URL').fill('wss://invalid.example.test/ws')
    await page.getByLabel('Description').fill(descriptionMarker)
    await panel.getByRole('button', { name: 'Test connection' }).click()
    await expect(panel.getByText('Connection successful!')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Add agent' }).click()
    await expect(panel).toBeHidden({ timeout: 10_000 })

    // A fresh account has no agent rows (system agents are not synced rows), so
    // this is the one we just created — identified without its (to-be-encrypted)
    // name, so the assertion below still flips on the fix.
    const row = await waitForAgentRow(userId)

    // SECURE assertion: user content must be encrypted at rest. Fails today (the
    // name is stored verbatim because `agents` is unmapped); passes once THU-870
    // adds `agents` to `encryptedColumnsMap`.
    expect(row.name).toMatch(/^__enc:/)
  })
})
