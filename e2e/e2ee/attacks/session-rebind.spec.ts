/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-873 — the device–session bind handshake, from both sides (C5/C14, A5).
 *
 * Pinning `getCallerDevice` to `session.deviceId` is only safe if a legitimate
 * device can (re)bind, and only *secure* if nobody else can. A session is linked
 * at first registration and never again, so an ordinary session expiry leaves a
 * fully enrolled device holding its keys with a session bound to nothing. If
 * binding did not work, that device would be locked out of every keyring,
 * challenge and rotation route — the whole account, silently, on a timer.
 *
 * Test 1 is therefore the LIVENESS gate: a re-authenticated device must recover
 * its authority with no user action and no re-approval. It is the regression
 * this fix is most likely to cause and the one no other spec covers.
 *
 * Test 2 is the SECURITY gate: a session that holds no device key cannot bind to
 * a device it does not own, so it cannot buy back the authority the pin took
 * away. Together they say: binding is available exactly to the device that
 * proves possession of its own private key, and to nobody else.
 *
 * Both assert the SECURE/CORRECT behaviour and pass on fixed code. Test 1 fails
 * if the client stops binding at startup or the handshake breaks; test 2 fails
 * if the bind route ever accepts an unopened nonce.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/session-rebind.spec.ts
 */

import { expect, test } from '../fixtures'
import { deleteUserSessions, getSessionDeviceIds, waitForUserId } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  encryptionApiRequest,
  getDeviceId,
  loginViaConsumerOtp,
  stolenSessionContext,
} from '../helpers'

const hasNonce = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && typeof (body as { nonce?: unknown }).nonce === 'string'

test.describe.serial('THU-873 — device–session binding', () => {
  test('a re-authenticated device rebinds itself and keeps its trust authority', async ({ page }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    const deviceId = await getDeviceId(page)

    // Enrollment bound the session (POST /devices links at first registration).
    expect(await getSessionDeviceIds(userId)).toEqual([deviceId])

    // Session expiry: the row goes away while the device keeps its localStorage
    // device id and its IndexedDB key pair. This is the ordinary case, not an
    // edge case — nothing re-links a session after the wizard has run once.
    await deleteUserSessions(userId)
    // Drop the now-dead bearer exactly as the real expiry path does
    // (`session_expired` in use-powersync-credentials-invalid-listener.ts calls
    // `clearAuthToken()` and deliberately preserves the DB, keys and device id).
    // Without this the app renders the sign-in modal OVER the landing form and
    // the re-login helper sees two Email inputs.
    await page.evaluate(() => localStorage.removeItem('thunderbolt_auth_token'))
    await loginViaConsumerOtp(page, email)

    // The client binds at startup / on sign-in success, so the fresh session is
    // bound to this same device WITHOUT any re-approval.
    await expect.poll(async () => await getSessionDeviceIds(userId), { timeout: 30_000 }).toEqual([deviceId])

    // ...and its authority is intact: it can obtain a trust challenge again.
    const challenge = await encryptionApiRequest(page, '/encryption/challenge?operation=rotate', { deviceId })
    expect(challenge.status).toEqual(200)
    expect(hasNonce(challenge.body)).toBe(true)
  })

  test('a session holding no device key cannot bind itself to that device', async ({ browser, page }) => {
    const email = createE2eeEmail()

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    const victimDeviceId = await getDeviceId(page)

    const attacker = await stolenSessionContext(browser, email)
    try {
      // Asking for a challenge naming the victim's device is deliberately
      // ALLOWED: the header is a claim, and the reply is a nonce SEALED to the
      // victim's registered public key, so it leaks nothing.
      const challenge = await encryptionApiRequest(attacker.page, '/devices/me/bind-challenge', {
        deviceId: victimDeviceId,
      })
      expect(challenge.status).toEqual(200)
      const sealed = (challenge.body as { sealed?: Record<string, string> }).sealed
      expect(typeof sealed?.ciphertext).toBe('string')

      // Completing the bind needs the nonce INSIDE that blob, which needs the
      // victim device's private key. Guessing fails.
      const forged = await encryptionApiRequest(attacker.page, '/devices/me/bind', {
        method: 'POST',
        deviceId: victimDeviceId,
        body: { deviceId: victimDeviceId, nonce: 'guessed-nonce' },
      })
      expect(forged.status).toEqual(403)

      // So the attacker's session stays unbound, and remains unable to act as
      // the victim device.
      const boundDevices = await getSessionDeviceIds(userId)
      expect(boundDevices.filter((id) => id === victimDeviceId)).toHaveLength(1)

      const spoofed = await encryptionApiRequest(attacker.page, '/encryption/challenge?operation=rotate', {
        deviceId: victimDeviceId,
      })
      expect(spoofed.status).toEqual(403)
      expect(hasNonce(spoofed.body)).toBe(false)
    } finally {
      await attacker.context.close()
    }
  })
})
