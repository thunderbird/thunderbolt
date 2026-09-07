/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-874 — plaintext injection into a synced `models` row (C1/C3, adversary A2,
 * High). **Claim: a non-`__enc:v2` value arriving in a mapped column on a v2
 * account must be quarantined on download, never persisted.**
 *
 * The download path decodes only values for which `isEncryptedValue` is true and
 * persists everything else verbatim — it intentionally does not consult
 * `encryptedColumnsMap` on decode, so stale bundles still decrypt
 * (src/db/powersync/middleware/EncryptionMiddleware.ts:40-44,
 * src/db/encryption/codec.ts:349-351). So A2 can write PLAINTEXT into a mapped
 * `models` column. With `provider: 'custom'` + a plaintext `url`, inference then
 * ships the full decrypted prompt — and, via the `models_secrets` LEFT JOIN, the
 * user's real upstream API key — to the attacker's endpoint
 * (src/ai/fetch.ts:307-326, src/dal/models.ts:14-25). The OTA defaults path
 * guards this exact provider flip (`frozenFields`); the sync-download path does
 * not.
 *
 * This spec proves the root cause on the same row that carries the exfil: A2
 * inserts a `models` row with plaintext `name`/`model`/`url` and `provider:
 * 'custom'`. The client persists it verbatim, so the plaintext `name` (a mapped
 * column) shows in the models list — the identical defect that leaves the
 * plaintext `url` live for inference. Asserting the visible `name` avoids driving
 * a full completion while proving the mapped-column plaintext was persisted.
 *
 * Capability audit: the only attacker power is A2 writing a row to the synced
 * `models` table it already relays — exactly a malicious/compelled server.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — the
 * injected plaintext must be quarantined (not shown) — and is tagged
 * `test.fail()` because the vuln is open today, so that assertion fails now. When
 * THU-874 is fixed (make the download path map-aware — quarantine a non-`__enc:v2`
 * value in a mapped column, mirroring `findPlaintextViolation`), the plaintext is
 * dropped, the assertion passes, and Playwright flags the unexpected pass → drop
 * the `test.fail()` tag for a permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/models-plaintext-injection.spec.ts
 */

import { expect, test } from '../fixtures'
import { injectPlaintextModel, waitForUserId } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, loginViaConsumerOtp } from '../helpers'

test.describe.serial('THU-874 — models plaintext injection', () => {
  test('a server-injected plaintext value in a mapped models column is persisted verbatim', async ({ page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()
    const nameMarker = `attacker-model-${crypto.randomUUID()}`
    const urlMarker = `https://attacker-${crypto.randomUUID()}.example.com/v1`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    // A2 writes a models row with PLAINTEXT in mapped columns + a custom
    // endpoint. Injected BEFORE the models page is opened so it rides the same
    // sync wave as the reconciled defaults.
    await injectPlaintextModel(userId, {
      id: crypto.randomUUID(),
      name: nameMarker,
      modelName: 'gpt-4o',
      url: urlMarker,
    })

    // Open the models list and let it fully hydrate: wait for the first row, then
    // for the row count to stop changing (all synced rows — defaults + the
    // injected one — have rendered). This is the sync barrier that makes the
    // absence assertion below deterministic rather than racing the download.
    await page.goto('/settings/models')
    const modelRows = page.getByRole('button', { name: /^Open / })
    await expect(modelRows.first()).toBeVisible({ timeout: 30_000 })
    let previousCount = -1
    await expect
      .poll(
        async () => {
          const count = await modelRows.count()
          const settled = count > 0 && count === previousCount
          previousCount = count
          return settled
        },
        { timeout: 30_000, intervals: [1000] },
      )
      .toBe(true)

    // SECURE assertion: the injected plaintext name must be quarantined, not
    // shown. Fails today (the download path persists it verbatim, so the marker
    // is now rendered); passes once THU-874 makes the download path map-aware.
    await expect(page.getByText(nameMarker)).toBeHidden()
  })
})
