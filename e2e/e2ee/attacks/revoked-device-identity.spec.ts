/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * C5 — "Revocation is cryptographic, not cosmetic." **Claim holds.**
 *
 * Hypothesis tested and refuted. The signing identity is account-wide, not
 * per-device — `canary secret --HKDF--> ECDSA P-256 keypair` gates every trust
 * op — and the canary is anchored permanently to DEK "0", which a revoked
 * device keeps locally (see primitives.spec.ts). Neither `rotateDEK` nor the
 * `rotateAK` wrapper re-mints it, so a revoked device looked like it should
 * retain a forever-valid signing identity.
 *
 * It does not: `runAKRotation` (src/services/encryption.ts) mints a fresh canary
 * under DEK "0" and derives a new signing keypair on EVERY AK rotation,
 * including the silent one revocation triggers. The code says why in as many
 * words — "a revoked device knows the old canary secret and could otherwise keep
 * forging approve/revoke/rotate proofs".
 *
 * This spec is therefore a regression test, not an exploit: it fails if that
 * re-mint is ever refactored away.
 *
 * Residual worth its own pass: DEK "0" is retained forever and the revoked
 * device still holds it, so every FUTURE canary is encrypted under a key that
 * device can unwrap. The re-mint protects only because a revoked device cannot
 * fetch the new canary ciphertext — a route-level device-state check
 * (`getCallerDevice`) whose device id comes from the client-supplied
 * `X-Device-ID` header. Whether that is spoofable by an A4 holding a live
 * session is untested here.
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

      // DEK "0" is retained forever because the canary is anchored to it, which
      // is precisely what keeps the signing key derivable.
      expect(Object.keys(after.wrappedKeys)).toContain('0')

      // THE PROTECTION: a fresh canary under DEK "0" yields a new signing
      // keypair, so the secret the revoked device captured no longer verifies.
      // Losing this assertion means revocation stops being cryptographic.
      expect(await getSigningPublicKey(userId)).not.toEqual(signingKeyBefore)

      // It does still hold DEK "0" — the derivation INPUT survives, only the
      // secret changed. That is what the residual note above is about.
      expect(await getEncryptionKeyNames(victim.page)).toEqual(expect.arrayContaining(['thunderbolt_dek_0']))

      // Defence in depth: sessions are revoked too, so it cannot reach an
      // authenticated route to fetch the new canary in the first place.
      expect(await countDeviceSessions(userId, victim.deviceId)).toEqual(0)
    } finally {
      await victim.context.close()
    }
  })
})
