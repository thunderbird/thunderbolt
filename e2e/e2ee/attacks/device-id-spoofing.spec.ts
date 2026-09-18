/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A1 — `X-Device-ID` spoofing and revoked-session replay (C5, C6, C14).
 * **Claims hold.** The residual C5 left open ("whether an A4 holding a live
 * session can spoof `X-Device-ID`") is settled here at the HTTP layer, and
 * since THU-873 the spoof is refused outright rather than merely useless.
 *
 * The challenge protocol still does not authenticate *which* device signs: the
 * signing keypair is account-wide (canary --HKDF--> ECDSA) and a revoked device
 * retains it (THU-872). What changed with THU-873 is that the caller's identity
 * no longer comes from the signature OR the header: `getCallerDevice` resolves
 * it from `session.deviceId`, which only the sealed-nonce bind handshake can
 * set. Test 2 pins that — the device id in a proof is now SERVER-resolved, so a
 * session cannot name a sibling at all. Test 1 pins the other barrier.
 *
 * C5's cryptographic revocation therefore rests on two barriers now: a revoked
 * device must not reach an authenticated route to fetch the post-rotation canary
 * (which is re-wrapped under the retained DEK "0" it still holds — see
 * revoked-device-identity.spec.ts), AND a session must not be able to act as a
 * device it cannot prove possession of. Test 1 replays the revoked device's
 * *retained bearer token* — the real credential, not just a check of the deleted
 * session row — and asserts every trust endpoint refuses it, even when it spoofs
 * a trusted sibling's device id.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/device-id-spoofing.spec.ts
 */

import { expect, test } from '../fixtures'
import { countDeviceSessions, getSigningPublicKey, waitForUserId } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  encryptionApiRequest,
  getDeviceId,
  loginViaConsumerOtp,
  revokedDeviceContext,
  trustAdditionalDevice,
} from '../helpers'

const challengePath = (operation: string) => `/encryption/challenge?operation=${operation}`

const hasNonce = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && typeof (body as { nonce?: unknown }).nonce === 'string'

test.describe.serial('A1 — X-Device-ID spoofing and revoked-session replay', () => {
  test('a revoked device cannot reach any trust endpoint, even spoofing a trusted sibling id', async ({
    browser,
    page,
  }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    const adminDeviceId = await getDeviceId(page)

    // Attacker: trusted, then revoked, browser context left open so it keeps its
    // cached bearer token AND its local DEK "0" (A4).
    const attacker = await revokedDeviceContext(browser, page, { email, userId, profile: 'firefox' })
    try {
      // Precondition: the session row is gone (C5 defence-in-depth, pinned in
      // revoked-device-identity.spec.ts). This test proves the *retained token*
      // that outlives that row is refused in practice.
      expect(await countDeviceSessions(userId, attacker.deviceId)).toEqual(0)

      // Spoofing its own revoked id: refused at the session layer (401) before
      // ever reaching the getCallerDevice 403.
      const ownId = await encryptionApiRequest(attacker.page, challengePath('revoke'), {
        deviceId: attacker.deviceId,
      })
      expect(ownId.status).toEqual(401)

      // Spoofing a TRUSTED sibling's id — the id whose device-state gate would
      // pass if the session were alive. Only session death stops it.
      const spoofSibling = await encryptionApiRequest(attacker.page, challengePath('revoke'), {
        deviceId: adminDeviceId,
      })
      expect(spoofSibling.status).toEqual(401)

      // No device id at all: still 401 (session checked before the 400).
      const noId = await encryptionApiRequest(attacker.page, challengePath('revoke'), {})
      expect(noId.status).toEqual(401)

      // The attacker changed nothing: the admin is still authenticated and the
      // account signing identity is intact.
      expect(await countDeviceSessions(userId, adminDeviceId)).toBeGreaterThan(0)
      expect(await getSigningPublicKey(userId)).not.toBeNull()
    } finally {
      await attacker.context.close()
    }
  })

  test('the challenge device id is resolved from the session, not asserted by the caller', async ({
    browser,
    page,
  }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    const adminDeviceId = await getDeviceId(page)

    const sibling = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      // A live trusted device gets a nonce for its own id — the baseline.
      const own = await encryptionApiRequest(page, challengePath('revoke'), { deviceId: adminDeviceId })
      expect(own.status).toEqual(200)
      expect(hasNonce(own.body)).toBe(true)

      // ...but NOT for a different trusted device's id, even though that device
      // is live and non-revoked and this caller holds the account signing key.
      // THU-873: the caller is `session.deviceId`, so naming a sibling is
      // refused outright. Before the fix this returned 200 with a usable nonce.
      const asSibling = await encryptionApiRequest(page, challengePath('revoke'), { deviceId: sibling.deviceId })
      expect(asSibling.status).toEqual(403)
      expect(hasNonce(asSibling.body)).toBe(false)

      // An unknown id is 403, NOT 404: the session/header mismatch is checked
      // before the device lookup, so a caller cannot probe which device ids
      // exist on its own account.
      const unknown = await encryptionApiRequest(page, challengePath('revoke'), {
        deviceId: `unknown-${crypto.randomUUID()}`,
      })
      expect(unknown.status).toEqual(403)

      // ...and a missing id is still 400. Neither yields a nonce.
      const missing = await encryptionApiRequest(page, challengePath('revoke'), {})
      expect(missing.status).toEqual(400)
    } finally {
      await sibling.context.close()
    }
  })
})
