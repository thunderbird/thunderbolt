/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-877 — forged v1 envelope + canary poisons the `"v1"` slot (C7/C8,
 * adversary A2, Medium). **Claim: the migrator must not absorb a legacy CK it
 * cannot verify against material the server does not control.**
 *
 * On the v1->v2 upgrade the migrator used to read the legacy CK from THIS
 * device's v1 envelope (`fetchMyEnvelope` -> `unwrapLegacyCK`) and check it only
 * against the server-supplied canary (`recoverCanarySecretV1`). Since A2 holds
 * every device's public keys and the canary/envelope rows, it can serve a forged
 * envelope wrapping a CK of its choosing plus a matching canary; the migrator
 * absorbed that attacker CK as the `"v1"` slot and minted DEK-0 over it, sealing
 * every pre-migration row under a key nobody legitimate holds. That proved C8's
 * "cannot be satisfied by A2" false. A2 learns no plaintext — this is
 * availability and integrity only, and THU-876 removed the confidentiality half.
 *
 * The fix verifies the offered CK against material A2 does not author, and FAILS
 * CLOSED. Two anchors, in order: a real legacy row that synced to this device
 * (a CK that decrypts it IS the CK — a GCM auth tag cannot be forged), and,
 * only when no such row has arrived yet, the CK this device kept from v1. The
 * local copy can never be absorbed in its place: v1 stored it NON-EXTRACTABLE,
 * so `crypto.subtle.wrapKey` cannot put it in the keyring — it can only be
 * compared against, by sealing a probe under one key and opening it under the
 * other.
 *
 * The secure outcome is therefore a REFUSED migration, not recovered data. A
 * device cannot read legacy rows without the real CK, and A2 will not hand it
 * over; refusing leaves the account on v1 with its ciphertext intact and the
 * migration retryable once the server serves the genuine envelope. Absorbing
 * instead sealed that data under a key nobody holds, permanently.
 *
 * This spec covers the locally-retained-CK anchor end to end, because that is the
 * one a real migrator has: sync is OFF until the wizard turns it on, so no legacy
 * row is on the device when the migrator runs. (A real v1 user who had sync
 * enabled has both anchors; a fresh device seeded against a v1 account has
 * neither, which is the residual below.) The synced-row anchor and the
 * both-anchors-absent residual are unit-tested in
 * `src/services/encryption.test.ts`.
 *
 * Capability audit: every seeded server row models A2's own state — the device
 * public keys it stored and the envelope/canary rows it serves. The legacy task is
 * the honest user's real-CK data. The client is not modified.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/forged-v1-envelope-poison.spec.ts
 */
import { expect, test } from '../fixtures'
import {
  getEncryptionServerSnapshot,
  getSchemeVersion,
  seedV1Envelope,
  seedV1Metadata,
  seedV1Task,
  trustDevice,
  waitForDeviceKeys,
  waitForUserId,
} from '../db'
import {
  createE2eeEmail,
  createV1SeedCrypto,
  loginViaConsumerOtp,
  registerDeviceOnly,
  runSeamlessMigration,
  seedLocalLegacyCK,
} from '../helpers'

test.describe.serial('THU-877 — forged v1 envelope poison', () => {
  test('the migrator refuses a forged envelope instead of absorbing it and orphaning legacy data', async ({ page }) => {
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

    // A2 forges the envelope AND a matching canary (+ its possession hash), so the
    // D1 proof is self-consistent and passes on its own. The legacy task stays
    // encrypted under the REAL CK — it is what the offered key must open.
    await seedV1Metadata(userId, await attackerCk.makeCanary())
    await seedV1Envelope(userId, migratorKeys.deviceId, await attackerCk.wrapForDevice(migratorKeys))
    await trustDevice(migratorKeys.deviceId)
    await seedV1Task(userId, crypto.randomUUID(), await realCk.encryptV1(legacyTaskText))

    // This device has been running v1, so it still holds the genuine CK — the
    // anchor the check uses. It can only be compared against, never absorbed:
    // v1 stored it non-extractable.
    await seedLocalLegacyCK(page, await realCk.exportRaw())

    // The wizard surfaces the abort; the server-side assertions below are the gate.
    await runSeamlessMigration(page).catch(() => {})

    // SECURE assertion: nothing was absorbed. The account stays on scheme 1 with no
    // `"v1"` slot, so the legacy ciphertext is untouched and the migration retries
    // cleanly. Before the fix the attacker CK landed in the keyring, scheme_version
    // flipped to 2, and every pre-migration row was sealed under a key nobody holds.
    await expect.poll(async () => await getSchemeVersion(userId), { timeout: 20_000 }).not.toBe(2)
    const snapshot = await getEncryptionServerSnapshot(userId).catch(() => null)
    expect(Object.keys(snapshot?.wrappedKeys ?? {})).not.toContain('v1')
  })
})
