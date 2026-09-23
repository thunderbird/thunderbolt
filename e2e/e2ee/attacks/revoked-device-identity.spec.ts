/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * C5 — "Revocation is cryptographic, not cosmetic." **Claim holds.**
 *
 * Hypothesis tested and refuted. The signing identity is account-wide, not
 * per-device — `canary seed --HKDF--> ECDSA P-256 keypair` gates every trust
 * op — so a revoked device looked like it should retain a forever-valid
 * signing identity.
 *
 * It does not: `runAKRotation` (src/services/encryption.ts) mints a fresh canary
 * and derives a new signing keypair on EVERY AK rotation, including the silent
 * one revocation triggers. The code says why in as many words — "a revoked
 * device knows the old canary secret and could otherwise keep forging
 * approve/revoke/rotate proofs".
 *
 * This spec is therefore a regression test, not an exploit: it fails if that
 * re-mint is ever refactored away.
 *
 * **The re-mint only became a real protection with THU-872.** While the canary
 * was anchored to DEK "0" — retained forever and still held by the revoked
 * device — every FUTURE canary was encrypted under a key that device could
 * unwrap, so it computed each new secret as it was minted and therefore each
 * new signing key. The assertion below (`getSigningPublicKey(...)` changed) was
 * true and beside the point. Re-anchoring the canary to the AK closed that: the
 * AK is replaced on every rotation and never delivered to a revoked device, so
 * the new canary is unreadable to it. What this spec asserts is now load-bearing
 * rather than cosmetic, but it checks the re-mint only — the lockout itself is
 * witnessed by `attacks/revoked-device-signing-key.spec.ts`.
 *
 * Note on the route (corrected 2026-09-12, still true): the break was never
 * reachable through `GET /encryption/canary`. The session check asserted at the
 * end of this spec (`countDeviceSessions === 0`) stops A4 reaching that route at
 * all, and the route was irrelevant anyway — the A2 + A4 collusion that carried
 * THU-872 had a server owning `encryption_metadata` that simply read
 * `canary_ctext` out of the row. `canary-route-ungated.spec.ts` covers the
 * ungated route as separate metadata hygiene.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/revoked-device-identity.spec.ts
 */

import { expect, test } from '../fixtures'
import {
  countDeviceSessions,
  getEncryptionServerSnapshot,
  getSigningPublicKey,
  waitForConsumedChallenge,
  waitForDeviceState,
  waitForUserId,
} from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  trustAdditionalDevice,
} from '../helpers'

test.describe.serial('C5 — revocation and the account signing identity', () => {
  test('re-mints the account signing identity so a revoked device cannot forge proofs', async ({ browser, page }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const victim = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      const before = await getEncryptionServerSnapshot(userId)
      const signingKeyBefore = await getSigningPublicKey(userId)
      expect(signingKeyBefore).not.toBeNull()

      await revokeTrustedDevice(page, victim.label)
      await waitForConsumedChallenge(userId, 'revoke')
      await waitForDeviceState(userId, victim.deviceId, (state) => state.revokedAt !== null)

      // `revokeDeviceAndRotate` revokes first, THEN rotates DEK and AK, so
      // `revokedAt` lands well before the rotation does. Poll for the rotation
      // rather than reading once — a single read passes on an idle machine and
      // fails under suite load.
      await expect
        .poll(async () => (await getEncryptionServerSnapshot(userId)).keyVersion, { timeout: 30_000 })
        .toBeGreaterThan(before.keyVersion)

      const after = await getEncryptionServerSnapshot(userId)

      // Rotation really happened — this is not a case of revocation doing nothing.
      expect(after.primaryKeyId).not.toEqual(before.primaryKeyId)

      // DEK "0" is retained forever so historical rows stay readable. It is no
      // longer the canary's anchor, so retaining it no longer keeps the signing
      // key derivable (THU-872).
      expect(Object.keys(after.wrappedKeys)).toContain('0')

      // THE PROTECTION: the rotation mints a fresh canary, so the secret the
      // revoked device captured no longer verifies. Since THU-872 the new
      // canary is sealed under the new AK, so the device cannot re-derive the
      // replacement either. Losing this assertion means revocation stops being
      // cryptographic.
      expect(await getSigningPublicKey(userId)).not.toEqual(signingKeyBefore)

      // It does still hold DEK "0" — retained for dual-read, and harmless now
      // that the canary no longer derives from it.
      expect(await getEncryptionKeyNames(victim.page)).toEqual(expect.arrayContaining(['thunderbolt_dek_0']))

      // Sessions are revoked too, so A4 cannot reach an authenticated route to
      // fetch the new canary. NOT what protects the signing key: a colluding
      // server relays the canary envelope without any route, which is why the
      // fix had to be the AK anchor rather than a gate (THU-872).
      expect(await countDeviceSessions(userId, victim.deviceId)).toEqual(0)
    } finally {
      await victim.context.close()
    }
  })
})
