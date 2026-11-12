/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh approval-code-substitution.spec.ts
 *
 * A2 sits in the middle of a short-code approval and substitutes the pending
 * device's keys, keeping its own story consistent: it serves the trusted device
 * a session it committed to over the SUBSTITUTED keys, relays the trusted
 * device's challenge to the real pending device so that one shows a real code,
 * then answers the trusted device with its own reveal. Each device sees a
 * well-formed attempt; the server holds both sides of the relay.
 *
 * Why it fails for A2: both codes hash the key tuple, and A2 committed to its
 * reveal before it saw the trusted device's challenge. The trusted device's
 * code covers the substituted keys, the pending device's code covers its real
 * keys, and A2 cannot steer the two together: one chance in a hundred per
 * attempt (two-digit codes), with nothing to grind offline. The user compares,
 * finds no match, and no envelope is ever written. A run that hits that one
 * chance is skipped, not failed: it is the residual the threat model accepts.
 *
 * Capability audit: A2 only, reading and writing its own `devices` and
 * `device_approval_sessions` rows. No access to either device's memory, the
 * user's keys, or the screens.
 *
 * Polarity: asserts the SECURE behavior. The trusted device reaches the code
 * choice (so the forged commitment really was accepted), the code it would
 * accept differs from the one the pending device shows, and picking the pending
 * device's code approves nothing.
 */

import {
  createApprovalCodeContext,
  createApprovalCommitment,
  createApprovalNonce,
  createApprovalSessionId,
  deriveApprovalCode,
} from '../../../src/crypto/device-approval-code'
import {
  exportMlKemPublicKey,
  exportPublicKey,
  generateKeyPair,
  generateMlKemKeyPair,
} from '../../../src/crypto/primitives'
import {
  getEncryptionServerSnapshot,
  sql,
  waitForApprovalSession,
  waitForDeviceState,
  waitForUserId,
  writeApprovalSession,
} from '../db'
import { expect, test } from '../fixtures'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createIsolatedDevice,
  getDeviceId,
  loginViaConsumerOtp,
  openPendingApproval,
  startAdditionalDeviceSetup,
} from '../helpers'

test.describe('Short-code approval under a key-substituting server', () => {
  test('a consistent forged commitment never makes the two codes match', async ({ browser, page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)

    const device = await createIsolatedDevice(browser, 'firefox')
    try {
      await loginViaConsumerOtp(device.page, email)
      await startAdditionalDeviceSetup(device.page)
      const deviceId = await getDeviceId(device.page)
      await waitForDeviceState(userId, deviceId, (state) => state.approvalPending && !state.trusted)
      const genuine = await waitForApprovalSession(deviceId)

      // A2 swaps the keys the trusted device will wrap the Account Key to.
      const substitutedEcdh = await exportPublicKey((await generateKeyPair()).publicKey)
      const substitutedMlkem = exportMlKemPublicKey(generateMlKemKeyPair().publicKey)
      await sql`UPDATE powersync.devices SET public_key = ${substitutedEcdh}, mlkem_public_key = ${substitutedMlkem}, name = 'Substituted approval fixture' WHERE id = ${deviceId} AND user_id = ${userId}`
      await expect(page.getByText('Substituted approval fixture', { exact: true })).toBeVisible({ timeout: 30_000 })

      // ...and a session of its own, committed over the substituted keys before any challenge exists.
      const forgedSessionId = createApprovalSessionId()
      const forgedReveal = createApprovalNonce()
      const forgedContext = await createApprovalCodeContext(
        { userId, deviceId, ecdhPublicKey: substitutedEcdh, mlkemPublicKey: substitutedMlkem },
        forgedSessionId,
      )
      const forged = {
        sessionId: forgedSessionId,
        commitment: await createApprovalCommitment(forgedContext, forgedReveal),
      }
      await writeApprovalSession(deviceId, { ...forged, challenge: null, challengerDeviceId: null, reveal: null })

      const releases: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith(`/devices/${deviceId}/envelope`)) {
          releases.push(request.url())
        }
      })

      const confirmation = await openPendingApproval(page, device.page)
      const challenged = await waitForApprovalSession(deviceId, (row) => row.challenge !== null)

      // Relay the trusted device's challenge to the real pending device, which reveals and shows its code.
      await writeApprovalSession(deviceId, {
        ...genuine,
        challenge: challenged.challenge,
        reveal: null,
        challengerDeviceId: challenged.challengerDeviceId,
      })
      await waitForApprovalSession(deviceId, (row) => row.reveal !== null)
      const shownCode = device.page.getByLabel('Approval code', { exact: true })
      await expect(shownCode).toHaveText(/^\d{2}$/, { timeout: 30_000 })
      const pendingCode = (await shownCode.textContent())!

      // Answer the trusted device with A2's own reveal, on the session it froze.
      await writeApprovalSession(deviceId, {
        ...forged,
        challenge: challenged.challenge,
        challengerDeviceId: challenged.challengerDeviceId,
        reveal: forgedReveal,
      })
      const options = confirmation.getByRole('group', { name: 'Codes to choose from' })
      await expect(options).toBeVisible({ timeout: 30_000 })

      const trustedCode = await deriveApprovalCode(
        forgedContext,
        challenged.challengerDeviceId!,
        challenged.challenge!,
        forgedReveal,
      )
      test.skip(trustedCode === pendingCode, 'Chance collision (1 in 100): the residual the threat model accepts')
      expect(trustedCode).not.toBe(pendingCode)

      // The user does the right thing: pick what the pending device shows, or say nothing matches.
      const pendingOption = options.getByRole('button', { name: pendingCode, exact: true })
      if ((await pendingOption.count()) > 0) {
        await pendingOption.click()
      } else {
        await confirmation.getByRole('button', { name: 'None of these match' }).click()
      }
      await expect(confirmation.getByText("The codes didn't match", { exact: true })).toBeVisible()

      const snapshot = await getEncryptionServerSnapshot(userId)
      expect(snapshot.envelopes[deviceId]).toBeUndefined()
      expect(releases).toEqual([])
      await waitForDeviceState(
        userId,
        deviceId,
        (state) => state.approvalPending && !state.trusted && !state.hasEnvelope,
      )
    } finally {
      await device.context.close()
    }
  })
})
