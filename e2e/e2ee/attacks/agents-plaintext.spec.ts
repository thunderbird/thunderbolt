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
 * adversary action, the server just reads them. Raised to Critical on re-review:
 * `validate-agent-url.ts` accepts userinfo and query strings, so a token-in-URL
 * endpoint is stored cleartext too, and there are no preconditions to stack down
 * from.
 *
 * The gap is invisible to the existing C1 oracle because `scanServerForPlaintext`
 * only scans MAPPED columns, so an unmapped synced table is never looked at —
 * which is exactly why this drift shipped. This spec therefore reads the
 * `agents` row directly rather than through that blind oracle.
 *
 * Capability audit: no adversary action at all. The client itself uploads the
 * plaintext; a passive server (A1/A2) simply stores and reads it.
 *
 * FIXED by THU-870 — `agents: ['name','url','description']` is in the map, this
 * spec passed, and the `test.fail()` tag was retired. It is now a permanent
 * regression gate and must stay green. No sync-rule change was needed: `agents`
 * was already synced, so only the map entry moved.
 *
 * RESIDUAL, deliberately not covered here: the fix is forward-only. Rows written
 * before the map entry existed stay cleartext at rest, because no re-encryption
 * pass exists anywhere in the system. This spec creates its agent after setup,
 * so it cannot witness that; it is recorded in C1 instead. Server-INJECTED
 * plaintext arriving on the download path is a different defect (THU-874) and is
 * not covered here either.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/agents-plaintext.spec.ts
 */

import { expect, test } from '../fixtures'
import { waitForAgentRow, waitForUserId } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, loginViaConsumerOtp } from '../helpers'

test.describe.serial('THU-870 — agents plaintext', () => {
  test('a custom agent encrypts name, url and description before they reach the server', async ({ page }) => {
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

    // SECURE assertion: every mapped column must be ciphertext at rest, not just
    // `name`. `url` is the load-bearing one — it is the routing field for both
    // transports, so cleartext there is what would let a server choose where the
    // agent connects. Asserting the markers are absent as well catches a partial
    // encode that leaves the plaintext somewhere in the row.
    expect(row.name).toMatch(/^__enc:/)
    expect(row.url).toMatch(/^__enc:/)
    expect(row.description).toMatch(/^__enc:/)
    expect(JSON.stringify(row)).not.toContain(nameMarker)
    expect(JSON.stringify(row)).not.toContain(descriptionMarker)
  })
})
