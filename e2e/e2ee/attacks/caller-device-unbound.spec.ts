/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-873 — `getCallerDevice` trusts `X-Device-ID` and never binds it to the
 * session (C5/C14, adversary A4/A5, High). **Claim: a trust route must resolve
 * the caller from its own session, not from a client-set header.**
 *
 * `getCallerDevice` (backend/src/api/encryption.ts:90-107) resolves the caller
 * purely from the `X-Device-ID` header — present, same user, not revoked — and
 * never checks it against `session.deviceId`. So ANY authenticated session can
 * assert ANY trusted device's id. `GET /encryption/challenge` (:734) then issues
 * a trust-operation nonce bound to that asserted id. Combined with the two facts
 * this repo already establishes — the signing key is account-wide and a revoked
 * device retains it (revoked-device-identity.spec.ts), and revocation deletes
 * only sessions LINKED to the device while re-auth sessions are never linked
 * (`revokeDeviceSessions` / `linkSessionToDevice`, backend/src/dal/sessions.ts) —
 * a revoked A4 with a surviving unlinked session presents a trusted sibling's id,
 * gets a `rotate` nonce, signs it with the retained key, and drives an
 * attacker-chosen AK rotation AFTER revocation (future plaintext + data loss).
 *
 * This spec proves the shared root cause deterministically: a session that is
 * NOT device V's obtains V's `rotate` challenge by setting `X-Device-ID: V`. The
 * A4 amplifier (retained key → signed rotate) rides on top of exactly this gate.
 *
 * Capability audit: the attacker uses only A5 powers — one authenticated session
 * (`stolenSessionContext`, holds no device keys) and a client-set header. A
 * trusted device id is not a secret (it is enumerable via
 * `GET /encryption/envelope-targets`); the spec reads V's id from setup for
 * determinism. The spec asserts only what it executes — the gate admits the
 * foreign session — not the downstream signed rotate (which needs A4's key).
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — a session
 * that does not own device V must NOT obtain V's trust challenge — and is tagged
 * `test.fail()` because the vuln is open today, so that assertion fails now. When
 * THU-873 is fixed (pin `getCallerDevice` to `session.deviceId`, fail-closed on
 * null), the foreign session is rejected, the assertion passes, and Playwright
 * flags the unexpected pass → drop the `test.fail()` tag for a permanent gate.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/caller-device-unbound.spec.ts
 */

import { expect, test } from '../fixtures'
import { waitForUserId } from '../db'
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

test.describe.serial('THU-873 — getCallerDevice unbound from session', () => {
  test('a session that does not own the device obtains its trust challenge by spoofing X-Device-ID', async ({
    browser,
    page,
  }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()

    // Victim first device, trusted.
    await loginViaConsumerOtp(page, email)
    await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    const victimDeviceId = await getDeviceId(page)

    // The attacker holds a separate authenticated session that is not bound to
    // the victim's device (an A5 stolen/unlinked session — the same shape as the
    // A4 revoked device's surviving re-auth session).
    const attacker = await stolenSessionContext(browser, email)
    try {
      // Baseline: without a spoofed id the gate refuses (proves the session is
      // not already device V, so the nonce below can only come from the header).
      const withoutHeader = await encryptionApiRequest(attacker.page, '/encryption/challenge?operation=rotate')
      expect(hasNonce(withoutHeader.body)).toBe(false)

      // Attack: assert the victim's trusted device id via the header.
      const spoofed = await encryptionApiRequest(attacker.page, '/encryption/challenge?operation=rotate', {
        deviceId: victimDeviceId,
      })

      // SECURE assertion: a session that does not own device V must not get V's
      // trust challenge. Fails today (nonce issued); passes once THU-873 pins
      // getCallerDevice to session.deviceId.
      expect(hasNonce(spoofed.body)).toBe(false)
    } finally {
      await attacker.context.close()
    }
  })
})
