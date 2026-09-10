/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-873 — a trust route resolves its caller from its own session, never from
 * a client-set header (C5/C14, adversaries A4/A5, High).
 *
 * `getCallerDevice` USED TO resolve the caller purely from the `X-Device-ID`
 * header — present, same user, not revoked — without ever comparing it to
 * `session.deviceId`, so ANY authenticated session could assert ANY trusted
 * device's id and `GET /encryption/challenge` would mint a trust-operation nonce
 * bound to that asserted id. Combined with two facts this repo establishes
 * elsewhere — the signing key is account-wide and a revoked device retains it
 * (revoked-device-identity.spec.ts), and revocation deletes only sessions LINKED
 * to the device while a re-authenticated session was never linked
 * (`revokeDeviceSessions` / `linkSessionToDevice`, backend/src/dal/sessions.ts) —
 * a revoked A4 with a surviving unlinked session could present a trusted
 * sibling's id, get a `rotate` nonce, sign it with the retained key, and drive an
 * attacker-chosen AK rotation AFTER revocation (future plaintext + data loss).
 *
 * This spec pins the shared root cause deterministically: a session that is NOT
 * device V's must not obtain V's `rotate` challenge by setting `X-Device-ID: V`.
 * The A4 amplifier (retained key → signed rotate) rode on top of exactly this
 * gate, so closing it closes both.
 *
 * Capability audit: the attacker uses only A5 powers — one authenticated session
 * (`stolenSessionContext`, holds no device keys) and a client-set header. A
 * trusted device id is not a secret (it is enumerable via
 * `GET /encryption/envelope-targets`); the spec reads V's id from setup for
 * determinism. The spec asserts only what it executes — the gate admits the
 * foreign session — not the downstream signed rotate (which needs A4's key).
 *
 * FIXED (THU-873). `getCallerDevice` now resolves the caller from
 * `session.deviceId` and rejects a header that does not match it, fail-closed
 * when the session is bound to nothing. Binding a session to a device is itself
 * authenticated: the server seals a nonce to the device's registered ECDH public
 * key (`GET /devices/me/bind-challenge`) and only that device can open it and
 * echo it back (`POST /devices/me/bind`). `POST /devices` no longer links a
 * session to an already-trusted device, which was the rebind bypass.
 *
 * Polarity: this spec asserts the SECURE property, so it PASSES on fixed code
 * and FAILS if the pin is removed, the bind handshake is weakened, or the
 * trusted fast path in `POST /devices` starts linking sessions again. Proven
 * non-vacuous by dry-run: with the pin removed it fails on the 403 assertion.
 *
 * Residual: the account signing key is still account-wide and a revoked device
 * retains it (THU-872), so this pin — not the proof — is what establishes WHICH
 * device is calling. The sync routes (`GET /powersync/token`, `PUT
 * /powersync/upload`) are pinned to the same binding, so a revoked device with a
 * surviving unlinked session can no longer name a trusted sibling to keep
 * reading or writing the stream; they answer `DEVICE_NOT_BOUND`, which the
 * client treats as a retryable defer rather than a revocation.
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

test.describe.serial('THU-873 — caller device is resolved from the session', () => {
  test('a session that does not own the device cannot obtain its trust challenge by spoofing X-Device-ID', async ({
    browser,
    page,
  }) => {
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
      // trust challenge. The status is asserted too — without it this would also
      // "pass" if the route broke for some unrelated reason.
      expect(spoofed.status).toEqual(403)
      expect(hasNonce(spoofed.body)).toBe(false)
    } finally {
      await attacker.context.close()
    }
  })
})
