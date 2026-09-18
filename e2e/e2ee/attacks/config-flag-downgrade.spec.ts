/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-868 / A2 — config-flag downgrade (C1, C2, Critical). **Claim: no `/config`
 * response can turn encryption off on a provisioned device.**
 *
 * The client used to gate its entire upload-encode path on `config.e2eeEnabled`,
 * a field served by the very server E2EE defends against — and `GET /v1/config`
 * is public and exempt from the app-version gate, so it is always reachable. One
 * lying response, or merely omitting the key (the client computed `=== true`, and
 * `updateConfig` replaces the whole stored object), disabled `encodeForUpload` on
 * a fully provisioned device: every encrypted column went up as plaintext, with
 * no UI signal and no server rejection. No user interaction, and it persisted
 * across restarts via localStorage.
 *
 * The fix removed the flag as an authority outright. Encryption is unconditional;
 * whether a value CAN be encrypted is decided by local key material plus the
 * codec's own fail-closed rule. `GET /v1/config` still SENDS a hardcoded
 * `e2eeEnabled: true`, purely so a pre-cutover bundle is not downgraded by
 * omission — which is why this spec serves `false` explicitly rather than
 * deleting the field. That compat shim is pinned separately by
 * `backend/src/api/config.test.ts`.
 *
 * Capability audit: A2 only — one lie on the wire for `GET /v1/config`
 * (`overrideAppConfig`). No key material, no session theft, no device access.
 *
 * Polarity: asserts the SECURE behavior and ships alongside the fix, so it lands
 * green with no `test.fail()` tag. Verified to be a real gate, not a vacuous one:
 * with the flag check reinstated in `encodeForUpload` it fails on the ciphertext
 * assertion. That regression is exactly what it exists to catch, and it matters
 * because `e2eeEnabled` still exists on the wire — a future change that "restores
 * the feature flag" client-side would otherwise pass every test.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/config-flag-downgrade.spec.ts
 */

import { expect, test } from '../fixtures'
import { getTaskIds, waitForNewEncryptedTasks, waitForUserId } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  loginViaConsumerOtp,
  overrideAppConfig,
} from '../helpers'
import { expectAllColumnsCiphertext, expectNoPlaintextOnServer } from '../oracles'

test.describe.serial('THU-868 — config-flag downgrade', () => {
  test('a server serving e2eeEnabled:false cannot force plaintext from a provisioned device', async ({ page }) => {
    const email = createE2eeEmail()
    const marker = `config-downgrade-${crypto.randomUUID()}`

    // Provision fully FIRST: the finding needed no unprovisioned device, it hit a
    // healthy one holding a complete keyring.
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)

    // A2 flips the flag off; the app re-reads `/config` on boot. Since
    // `updateConfig` replaces the whole object, this covers the omission variant
    // too — a stale client would read `undefined` and skip encryption.
    await overrideAppConfig(page.context(), { e2eeEnabled: false })
    await page.reload()

    const taskIdsBefore = await getTaskIds(userId)
    await createTask(page, marker)
    const newRows = await waitForNewEncryptedTasks(userId, taskIdsBefore)

    // SECURE assertion: the write is v2 ciphertext regardless of what /config said.
    expect(newRows.length).toBeGreaterThan(0)
    expect(newRows[0].item).toMatch(/^__enc:v2:/)
    expect(newRows[0].item).not.toContain(marker)

    // ...and the marker leaked nowhere else on the server either.
    await expectNoPlaintextOnServer([marker])
    await expectAllColumnsCiphertext(userId)
  })
})
