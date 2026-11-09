/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * C16 — inbox keys. **Claim: only a current key holder can publish an account's
 * inbox key, and a device locked out by revocation cannot open any version
 * minted after it.**
 *
 * The inbox key is what other accounts seal share keys to, and the server cannot
 * check a published public key against the seed it claims to derive from. So a
 * stolen session (A5) that could publish would swap in keys it controls and read
 * every chat shared with the account. Publishing is gated by an `inbox` proof
 * signed with the canary-derived key, which a session without keys cannot make.
 *
 * Revocation must also move the inbox key: its seed is sealed under the primary
 * DEK, and the revoked device holds the old primary. The rotation that locks it
 * out mints a new primary, and the next inbox version is sealed under that.
 *
 * Polarity: asserts the secure behaviour. The first test is the non-vacuity
 * anchor for the other two — it proves an honest device really publishes, so an
 * unchanged table below cannot be "nothing ever publishes".
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/inbox-key.spec.ts
 */

import { expect, test } from '../fixtures'
import { getInboxKeys, waitForConsumedChallenge, waitForDeviceState, waitForUserId } from '../db'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  encryptionApiRequest,
  getDeviceId,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  stolenSessionContext,
  trustAdditionalDevice,
} from '../helpers'
import { initialKeyId } from '../../../shared/e2ee-types'

/** A well-formed mint body: right sizes, and a proof that no key holder signed. */
const forgedMint = (deviceId: string) => ({
  version: 2,
  keyId: initialKeyId,
  ecdhPublicKey: 'E'.repeat(88),
  mlkemPublicKey: 'M'.repeat(1580),
  encryptedSeed: 'S'.repeat(80),
  proof: { signature: 'forged', nonce: 'forged-nonce', operation: 'inbox', deviceId },
})

test.describe.serial('C16 — inbox keys', () => {
  test('first-device setup publishes inbox version 1 under DEK "0"', async ({ page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    await expect
      .poll(async () => (await getInboxKeys(userId)).map((row) => [row.version, row.keyId]), { timeout: 30_000 })
      .toEqual([[1, initialKeyId]])
  })

  test('a stolen session cannot publish an inbox key', async ({ browser, page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await expect.poll(async () => (await getInboxKeys(userId)).length, { timeout: 30_000 }).toBe(1)
    const victimDeviceId = await getDeviceId(page)

    // A5: signed in as the victim, no keys. Naming the victim's device fails the
    // session binding; naming none fails the header check.
    const stolen = await stolenSessionContext(browser, email)
    for (const deviceId of [victimDeviceId, undefined]) {
      const response = await encryptionApiRequest(stolen.page, '/encryption/inbox', {
        method: 'POST',
        deviceId,
        body: forgedMint(victimDeviceId),
      })
      expect([400, 403]).toContain(response.status)
    }

    // The trusted device itself, without a real signature, is refused too: the
    // proof is the gate, not the device.
    const unsigned = await encryptionApiRequest(page, '/encryption/inbox', {
      method: 'POST',
      deviceId: victimDeviceId,
      body: forgedMint(victimDeviceId),
    })
    expect(unsigned.status).toBe(403)

    expect((await getInboxKeys(userId)).map((row) => row.version)).toEqual([1])
    await stolen.context.close()
  })

  test('revoking a device mints the next inbox version under the new primary', async ({ browser, page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await expect.poll(async () => (await getInboxKeys(userId)).length, { timeout: 30_000 }).toBe(1)

    const doomed = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    await revokeTrustedDevice(page, doomed.label)
    await waitForConsumedChallenge(userId, 'revoke')
    await waitForDeviceState(userId, doomed.deviceId, (state) => state.revokedAt !== null)

    // Version 1 stays, so shares sealed to it still open; version 2 is sealed
    // under DEK "1", which the revoked device never held.
    await expect
      .poll(async () => (await getInboxKeys(userId)).map((row) => [row.version, row.keyId]), { timeout: 30_000 })
      .toEqual([
        [1, initialKeyId],
        [2, '1'],
      ])
    await doomed.context.close()
  })
})
