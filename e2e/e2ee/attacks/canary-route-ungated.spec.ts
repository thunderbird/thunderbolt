/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-872 (route-gating half) — `GET /encryption/canary` is not device-gated
 * (C5, adversary A4, High). **Claim: the endpoint that serves the canary
 * ciphertext must verify the caller is a trusted, non-revoked device.**
 *
 * The account signing key is derived deterministically from the canary secret,
 * and the canary is re-minted under the never-rotating DEK-0 on every rotation
 * (src/crypto/canary.ts). A revoked device (A4) keeps DEK-0, so if it can still
 * FETCH the re-minted canary it can re-derive the CURRENT signing key and forge
 * approve/revoke/rotate proofs — unrevocable. The C5 regression test
 * (`revoked-device-identity.spec.ts`) argued revocation holds *because* a revoked
 * device cannot fetch the new canary, claiming the route is `getCallerDevice`-
 * gated. It is not: `GET /encryption/canary` is `{ auth: true }` only
 * (backend/src/api/encryption.ts:569-593) — no device-state check at all.
 *
 * This spec proves that one enabling gap: a session that is NOT a trusted device
 * still receives the canary material. The other two links of the full exploit are
 * already established elsewhere — a revoked device retains DEK-0
 * (`primitives.spec.ts` / `key-material-at-rest.spec.ts`) and the canary
 * deterministically yields the signing key (`backend` `canary.test.ts`). The full
 * signing-key re-derivation is confirmed by that composition; it is not forced
 * into one spec because doing so would require re-implementing the app's signing
 * derivation over a non-extractable key inside the page (fidelity risk).
 *
 * Capability audit: a single authenticated session with no trusted device
 * (`stolenSessionContext`, A5) — the same reachability a revoked A4 has through a
 * surviving unlinked session (THU-873). No key material is used here.
 *
 * Expected-failure (Option C): this test asserts the SECURE behavior — a
 * device-less session is refused the canary ciphertext — and is tagged
 * `test.fail()` because the vuln is open today, so that assertion fails now. When
 * THU-872 is fixed (device-gate `GET /encryption/canary`), the request is
 * refused, the assertion passes, and Playwright flags the unexpected pass → drop
 * the `test.fail()` tag for a permanent regression gate.
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

test.describe.serial('THU-872 — canary route not device-gated', () => {
  test('a session with no trusted device still receives the canary ciphertext', async ({ browser, page }) => {
    // Expected-failure while the vuln is open — see the file header (Option C).
    test.fail()

    const email = createE2eeEmail()

    // Victim sets up E2EE, so a canary exists on the server.
    await loginViaConsumerOtp(page, email)
    await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    // A session that is not bound to any trusted device (A5 — the same reach a
    // revoked A4 has via a surviving unlinked session).
    const attacker = await stolenSessionContext(browser, email)
    try {
      const response = await encryptionApiRequest(attacker.page, '/encryption/canary')

      // SECURE assertion: a device-less session must NOT be handed the canary
      // ciphertext. Fails today (the route has no device gate); passes once
      // THU-872 device-gates GET /encryption/canary.
      expect(hasCanaryCiphertext(response.body)).toBe(false)
    } finally {
      await attacker.context.close()
    }
  })
})
