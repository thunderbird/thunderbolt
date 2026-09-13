/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-872 (metadata-hygiene half) — `GET /encryption/canary` is not device-gated
 * (C9, adversary A5, Low). **Claim: the endpoint that serves the canary
 * ciphertext must verify the caller is a trusted, non-revoked device.**
 *
 * The route is `{ auth: true }` only (`backend/src/api/encryption.ts:742-765`) —
 * no `getCallerDevice`, so any authenticated session, bound to a device or not,
 * receives `canary_ctext`, `kdf_salt`, `signing_public_key`, the `recovery_*`
 * columns and `primary_key_id`. That is a real gap and this spec witnesses it.
 *
 * ## READ THIS BEFORE RETIRING THE TAG
 *
 * **Device-gating this route does NOT close THU-872, and this spec going green
 * must not be recorded as closing it.** Re-measured 2026-09-12: the two
 * capabilities never meet in one adversary.
 *
 *   - A4 (revoked device) can USE the canary — it retains DEK-0 — but cannot
 *     reach this route: the user-facing revoke runs `revokeDeviceSessions`
 *     (`DELETE FROM session WHERE device_id = $d`), so its session is gone, and
 *     minting a new one needs a fresh login.
 *   - A5 (stolen session, modelled here) can reach the route but holds no DEK-0,
 *     so `canary_ctext` is undecryptable bytes and `recovery_wrapped_ak` is inert
 *     against a 24-word phrase.
 *
 * And in the A2 + A4 collusion that actually carries THU-872, the route is not
 * used at all: a colluding server owns `encryption_metadata` and reads
 * `canary_ctext` out of the row. (`encryption_metadata` is also absent from all
 * three PowerSync sync-rule configs, so the canary never rides the sync stream.)
 *
 * So what this spec proves is an ungated-metadata leak, not the vulnerability.
 * THU-872's actual break — a revoked device re-deriving the account's CURRENT
 * signing key from retained DEK-0, because the signing key is
 * `HKDF(canary secret)` and the canary is permanently anchored to a DEK that
 * never re-keys — is witnessed by
 * `attacks/revoked-device-signing-key.spec.ts`. **That** spec is the one whose
 * tag tracks THU-872, and it is deliberately unaffected by gating this route.
 *
 * Do NOT chase this by widening the session sweep either: `session.device_id` is
 * nullable by design (a session exists before any device can register, and
 * `ensureSessionBound` no-ops for keyless clients), so permanently-unbound
 * sessions are the designed state for CLI device-grant sessions, bridge devices
 * and any browser signed in before E2EE setup. Deleting a user's unbound sessions
 * on revoke would log all of those out on every revocation for no security gain.
 *
 * Capability audit: a single authenticated session with no trusted device
 * (`stolenSessionContext`, A5). No key material is used here.
 *
 * Expected-failure (Option C): this asserts the SECURE behavior — a device-less
 * session is refused the canary ciphertext — and is tagged `test.fail()` because
 * the route is ungated today. Once the route is gated, drop the tag for a
 * permanent regression gate on the metadata leak, and leave THU-872 open.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/canary-route-ungated.spec.ts
 */

import { expect, test } from '../fixtures'
import { waitForUserId } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  encryptionApiRequest,
  loginViaConsumerOtp,
  stolenSessionContext,
} from '../helpers'

const hasCanaryCiphertext = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && typeof (body as { canary_ctext?: unknown }).canary_ctext === 'string'

test.describe.serial('THU-872 (metadata half) — canary route not device-gated', () => {
  test('a session with no trusted device still receives the canary ciphertext', async ({ browser, page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()

    // Victim sets up E2EE, so a canary exists on the server.
    await loginViaConsumerOtp(page, email)
    await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    // A session that is not bound to any trusted device (A5). NOT a stand-in for
    // a revoked A4: revocation deletes A4's session, and A5 holds no DEK-0.
    const attacker = await stolenSessionContext(browser, email)
    try {
      const response = await encryptionApiRequest(attacker.page, '/encryption/canary')

      // SECURE assertion: a device-less session must NOT be handed the canary
      // ciphertext. Fails today (the route has no device gate); passes once the
      // route is gated — which closes the metadata leak and NOT THU-872 itself.
      expect(hasCanaryCiphertext(response.body)).toBe(false)
    } finally {
      await attacker.context.close()
    }
  })
})
