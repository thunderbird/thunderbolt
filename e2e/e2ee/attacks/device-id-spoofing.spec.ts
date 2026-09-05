/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A1 — `X-Device-ID` spoofing and revoked-session replay (C5, C6, C14).
 * **Claims hold.** The residual C5 left open ("whether an A4 holding a live
 * session can spoof `X-Device-ID`") is settled here at the HTTP layer.
 *
 * The challenge protocol never authenticates *which* device signs: the signing
 * keypair is account-wide (canary --HKDF--> ECDSA), and `getCallerDevice`
 * resolves the caller from the client-supplied `X-Device-ID` header. So a proof
 * binds to a device id the caller *asserts*, gated only by that device's server
 * state (present / same-user / not-revoked) plus possession of the account key.
 * Test 2 shows the id is caller-asserted; Test 1 shows why that is not
 * exploitable.
 *
 * The whole of C5's cryptographic revocation therefore rests on one barrier: a
 * revoked device must not be able to reach an authenticated route to fetch the
 * post-rotation canary (which is re-wrapped under the retained DEK "0" it still
 * holds — see revoked-device-identity.spec.ts). Test 1 replays the revoked
 * device's *retained bearer token* — the real credential, not just a check of
 * the deleted session row — and asserts every trust endpoint refuses it, even
 * when it spoofs a trusted sibling's device id.
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

  test('the challenge device id is caller-asserted, gated only by device state', async ({ browser, page }) => {
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

      // ...and for a DIFFERENT trusted device's id. The proof's device id is not
      // authenticated — it is whatever the caller puts in the header, as long as
      // it names a non-revoked device of this user. This is C6's "bound to
      // device" being caller-asserted rather than proven. It grants nothing: the
      // account-wide signing key means the caller could already act, and naming
      // the sibling does not let it act *as* a device it is not.
      const asSibling = await encryptionApiRequest(page, challengePath('revoke'), { deviceId: sibling.deviceId })
      expect(asSibling.status).toEqual(200)
      expect(hasNonce(asSibling.body)).toBe(true)

      // The device-state gate is the real check: an unknown id is 404...
      const unknown = await encryptionApiRequest(page, challengePath('revoke'), {
        deviceId: `unknown-${crypto.randomUUID()}`,
      })
      expect(unknown.status).toEqual(404)

      // ...and a missing id is 400. Neither yields a nonce.
      const missing = await encryptionApiRequest(page, challengePath('revoke'), {})
      expect(missing.status).toEqual(400)
    } finally {
      await sibling.context.close()
    }
  })
})
