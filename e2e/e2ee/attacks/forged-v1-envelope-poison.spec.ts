/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-877 — forged v1 envelope + canary poisons the `"v1"` slot (C7/C8,
 * adversary A2, Medium). **Claim: the migrator must not absorb a legacy CK it
 * cannot verify against the account's real legacy data.**
 *
 * On the v1→v2 upgrade the migrator reads the legacy CK from THIS device's v1
 * envelope (`fetchMyEnvelope` → `unwrapLegacyCK`, src/services/encryption.ts:
 * 991-1009) and only checks it against the server-supplied canary
 * (`recoverCanarySecretV1`). Since A2 holds every device's public keys and the
 * canary/envelope rows, it can serve a forged v1 envelope wrapping a CK of its
 * choosing plus a matching canary; the migrator absorbs that attacker CK as the
 * `"v1"` slot — never checking it against a genuine local legacy row — and mints
 * DEK-0 over it. All pre-migration ciphertext (written under the real CK) is now
 * sealed under a key nobody legitimate holds. The damage outlasts the compromise:
 * the honest v2 upgrade discards the real CK, so the loss is permanent. This
 * proves C8's "cannot be satisfied by A2" false.
 *
 * The attack (A2 with DB access): plant an attacker-CK v1 envelope + canary
 * (+ its possession hash) while leaving the genuine legacy data encrypted under
 * the REAL CK. The migrator (real, unmodified) does the rest.
 *
 * Capability audit: every seeded row models A2's own state — the device public
 * keys it stored and the envelope/canary rows it serves. The legacy task is the
 * honest user's real-CK data. The client is not modified.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — the real
 * legacy data survives the migration (stays readable) — and is tagged
 * `test.fail()` because the vuln is open today, so that assertion fails now (the
 * migrator absorbed the attacker CK, orphaning the data). When THU-877 is fixed
 * (verify the candidate CK against a real local legacy row before absorbing it),
 * the forged CK is rejected, the legacy data survives, the assertion passes, and
 * Playwright flags the unexpected pass → drop the `test.fail()` tag for a
 * permanent regression gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/forged-v1-envelope-poison.spec.ts
 */

import { expect, test } from '../fixtures'
import {
  seedV1Envelope,
  seedV1Metadata,
  seedV1Task,
  trustDevice,
  waitForDeviceKeys,
  waitForSchemeV2,
  waitForUserId,
} from '../db'
import {
  createE2eeEmail,
  createV1SeedCrypto,
  enableTasks,
  loginViaConsumerOtp,
  registerDeviceOnly,
  runSeamlessMigration,
} from '../helpers'

test.describe.serial('THU-877 — forged v1 envelope poison', () => {
  test('the migrator absorbs an attacker CK from a forged envelope, orphaning legacy data', async ({ page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()
    const legacyTaskText = `legacy-real-ck-${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await registerDeviceOnly(page)
    const [migratorKeys] = await waitForDeviceKeys(userId, 1)

    // Two CKs: the genuine one the legacy data was written under, and the CK A2
    // substitutes on the wire.
    const realCk = await createV1SeedCrypto()
    const attackerCk = await createV1SeedCrypto()

    // A2 plants the forged envelope + matching canary (+ possession hash) it will
    // serve, while the legacy task stays encrypted under the REAL CK.
    await seedV1Metadata(userId, await attackerCk.makeCanary())
    await seedV1Envelope(userId, migratorKeys.deviceId, await attackerCk.wrapForDevice(migratorKeys))
    await trustDevice(migratorKeys.deviceId)
    await seedV1Task(userId, crypto.randomUUID(), await realCk.encryptV1(legacyTaskText))

    // The migrator upgrades: it unwraps the attacker CK from the forged envelope,
    // passes the (attacker) canary possession check, and absorbs it as "v1".
    await runSeamlessMigration(page)
    await waitForSchemeV2(userId, ['0', 'v1'])

    await enableTasks(page)
    await page.goto('/tasks')

    // SECURE assertion: the genuine legacy data must survive the migration. Fails
    // today (the "v1" slot holds the attacker CK, so the real-CK row can no longer
    // be decrypted); passes once the migrator verifies the CK against a real
    // legacy row before absorbing it.
    await expect(page.getByText(legacyTaskText, { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
