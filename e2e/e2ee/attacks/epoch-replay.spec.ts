/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * C5 — epoch replay after a revocation (adversary A2, beneficiary A4).
 * **Claim: once a device has adopted the epoch a revocation created, the server
 * cannot move it back to an older epoch, so new writes never return to a DEK
 * the revoked device holds.**
 *
 * DEK "0" is the same in every epoch, so an older envelope served with its own
 * keyring passes the DEK "0" witness. The served `key_version` cannot settle it
 * either, because the server controls it. The device compares two values sealed
 * inside the envelope with what it holds: the epoch its current AK came from,
 * and its primary pointer.
 *
 * Device A stays trusted; device C is revoked. The attack, using only A2's
 * powers (replay three GET responses it served before): A revokes C, which rotates the AK and mints primary DEK "1". A2 then
 * serves A the pre-revocation envelope, keyring and metadata, once as they were
 * and once with a forged newer `key_version`. Without the check, A adopts the
 * old epoch on reload and encrypts its next task under DEK "0", which C kept.
 *
 * A second case replays the epoch from before a phrase change. A phrase change
 * keeps the primary, so only the epoch floor refuses that replay.
 *
 * Non-vacuity: the refusal is logged, the write is real v2 ciphertext under
 * the current primary, and the task still renders, so the device kept working keys.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/epoch-replay.spec.ts
 */

import {
  getCanaryCiphertext,
  getEncryptionServerSnapshot,
  getTaskIds,
  waitForConsumedChallenge,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import { expect, test } from '../fixtures'
import {
  acknowledgeRecoveryPhrase,
  completeFirstDeviceSetup,
  completeStepUpCode,
  createE2eeEmail,
  createTask,
  enableTasks,
  getDeviceId,
  loginViaConsumerOtp,
  overrideEncryptionMetadata,
  revokeTrustedDevice,
  serveEnvelope,
  serveWrappedKeys,
  trustAdditionalDevice,
} from '../helpers'

test.describe('C5 — epoch replay after a revocation', () => {
  test('a replayed pre-revocation epoch cannot put new writes back under the revoked DEK', async ({
    browser,
    page,
  }) => {
    // Two devices, an approval and a revoke-rotation.
    test.slow()

    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    const doomed = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      // Everything A2 needs to replay the epoch before the revocation.
      const deviceId = await getDeviceId(page)
      const beforeRevocation = await getEncryptionServerSnapshot(userId)
      const canary = await getCanaryCiphertext(userId)
      expect(beforeRevocation.primaryKeyId).toBe('0')

      await revokeTrustedDevice(page, doomed.label)
      await expect
        .poll(() => getEncryptionServerSnapshot(userId), { timeout: 30_000 })
        .toMatchObject({ primaryKeyId: '1', keyVersion: beforeRevocation.keyVersion + 1 })

      const consoleLines: string[] = []
      page.on('console', (message) => consoleLines.push(message.text()))

      await serveEnvelope(page.context(), beforeRevocation.envelopes[deviceId])
      await serveWrappedKeys(
        page.context(),
        Object.entries(beforeRevocation.wrappedKeys).map(([key_id, wrapped_key]) => ({ key_id, wrapped_key })),
      )
      const replayedMetadata = { canary_iv: canary.iv, canary_ctext: canary.ctext, primary_key_id: '0' }

      // The complete replay, then the same envelope with a forged newer key_version.
      // Playwright tries the most recently registered route first.
      for (const keyVersion of [beforeRevocation.keyVersion, beforeRevocation.keyVersion + 5]) {
        await overrideEncryptionMetadata(page.context(), { ...replayedMetadata, key_version: keyVersion })
        consoleLines.length = 0
        const marker = `epoch-replay-${keyVersion}-${crypto.randomUUID()}`
        const before = await getTaskIds(userId)
        // `createTask` navigates, so the app re-inits against the replayed responses.
        await createTask(page, marker)

        await expect
          .poll(() => consoleLines.some((line) => line.includes('refused an inbound account key (stale-epoch)')), {
            timeout: 30_000,
          })
          .toBe(true)

        const rows = await waitForNewEncryptedTasks(userId, before)
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
          expect(row.item).toMatch(/^__enc:v2:1:/)
          expect(row.item).not.toContain(marker)
        }
        await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 })
      }
    } finally {
      await doomed.context.close()
    }
  })

  test('a replayed epoch from before a phrase change is refused although it seals the same primary', async ({
    page,
  }) => {
    // A phrase change rotates the AK without minting, so the primary stays "0"
    // and only the sealed epoch shows the replay is older.
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    const deviceId = await getDeviceId(page)
    const beforeChange = await getEncryptionServerSnapshot(userId)
    const canary = await getCanaryCiphertext(userId)

    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: 'Change Recovery Phrase' }).click()
    const confirmation = page.getByRole('alertdialog')
    await confirmation.getByRole('button', { name: 'Send code' }).click()
    await completeStepUpCode(page, email)
    const recoveryDialog = page.getByRole('dialog').filter({ hasText: 'Save your new recovery phrase' })
    await acknowledgeRecoveryPhrase(recoveryDialog)
    await waitForConsumedChallenge(userId, 'rotate')
    await expect
      .poll(() => getEncryptionServerSnapshot(userId), { timeout: 30_000 })
      .toMatchObject({ keyVersion: beforeChange.keyVersion + 1, primaryKeyId: '0' })

    const consoleLines: string[] = []
    page.on('console', (message) => consoleLines.push(message.text()))
    await serveEnvelope(page.context(), beforeChange.envelopes[deviceId])
    await serveWrappedKeys(
      page.context(),
      Object.entries(beforeChange.wrappedKeys).map(([key_id, wrapped_key]) => ({ key_id, wrapped_key })),
    )
    await overrideEncryptionMetadata(page.context(), {
      canary_iv: canary.iv,
      canary_ctext: canary.ctext,
      primary_key_id: '0',
      key_version: beforeChange.keyVersion + 5,
    })

    const marker = `phrase-epoch-replay-${crypto.randomUUID()}`
    const before = await getTaskIds(userId)
    await createTask(page, marker)

    await expect
      .poll(() => consoleLines.some((line) => line.includes('refused an inbound account key (stale-epoch)')), {
        timeout: 30_000,
      })
      .toBe(true)
    const rows = await waitForNewEncryptedTasks(userId, before)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.item).toMatch(/^__enc:v2:0:/)
    }
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
