/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-874 — plaintext injection into a synced `models` row (C1/C3, adversary A2,
 * High). **Claim: a non-`__enc:` value arriving in a mapped column on a v2
 * account must be quarantined on download, never persisted.**
 *
 * The download path used to decode only values for which `isEncryptedValue` was
 * true and persist everything else verbatim. So A2 could write PLAINTEXT into a
 * mapped `models` column: with `provider: 'custom'` + a plaintext `url`,
 * inference shipped the full decrypted prompt — and, via the `models_secrets`
 * LEFT JOIN, the user's real upstream API key — to the attacker's endpoint
 * (src/ai/fetch.ts, src/dal/models.ts). The OTA defaults path guards this exact
 * provider flip (`frozenFields`); the sync-download path did not.
 *
 * The fix is the download-side quarantine in `EncryptionMiddleware`
 * (`plaintextViolation`): on a device holding an Account Key — a CLIENT-LOCAL
 * fact, never the server-supplied scheme_version — a PUT carrying a non-`__enc:`
 * value in an `encryptedColumnsMap` column is flipped to a MOVE op: the op_id
 * and checksum are consumed (dropping outright would fail checkpoint
 * validation) but nothing is written. For the attack's real shape (mutating an
 * existing row) the previous good value simply stays; for an injected new row,
 * the row never lands. Decryption stays map-blind (stale bundles still decode
 * new columns); legacy `__enc:` v1 values stay accepted (dual-read); nothing is
 * ever nulled (the `models.name`/`url` NOT-NULL CRUD-wedge trap).
 *
 * Companion (same change): `agents` rows synced as plaintext in v1 production
 * and its columns joined the map only in v2, so the `reencrypt-agents` data
 * migration re-saves them through the encrypting upload path — removing the
 * last legitimate author of plaintext-in-a-mapped-column, which is what makes
 * this quarantine a sound rule rather than a heuristic with false positives.
 *
 * Capability audit: the only attacker power is A2 writing a row to the synced
 * `models` table it already relays — exactly a malicious/compelled server.
 *
 * Residuals: (1) A2 can still DELETE rows, or delete-and-reinsert them as
 * plaintext (the reinsert is quarantined) — hiding data is a DoS the server
 * has anyway, never a disclosure. (2) The injected plaintext row stays in
 * Postgres — the quarantine refuses it, nothing rewrites it. (3) An account
 * whose plaintext agents rows live on NO surviving device converges only when
 * a data-holding device runs the migration; until then those rows are
 * invisible on newly-enrolled devices.
 *
 * Polarity: asserts the SECURE behavior. Authored as an Option C
 * expected-failure while the vuln was open; the `test.fail()` tag was retired
 * when the quarantine landed (Playwright reported the unexpected pass) — now a
 * permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/models-plaintext-injection.spec.ts
 */

import { expect, test } from '../fixtures'
import { injectPlaintextModel, waitForUserId } from '../db'
import { completeFirstDeviceSetup, createE2eeEmail, loginViaConsumerOtp } from '../helpers'

test.describe.serial('THU-874 — models plaintext injection', () => {
  test('a server-injected plaintext value in a mapped models column is quarantined', async ({ page }) => {
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
