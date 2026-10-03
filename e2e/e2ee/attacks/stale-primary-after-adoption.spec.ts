/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * C5 — a surviving warmed device must not keep encoding under the old primary
 * DEK after adopting a revocation rotation (beneficiary A4, Critical).
 * **Claim: after a revocation rotates the primary DEK, every surviving device's
 * NEXT write is sealed under the new primary — forward secrecy is what
 * revocation buys, and it must not depend on a reload.**
 *
 * Mechanism: the codec's in-memory primary pointer is deliberately sticky —
 * `dropKeyringCaches` keeps `cachedPrimaryKeyId` (so a lying server cannot steer
 * a warmed device onto another key by provoking invalidations), and both
 * `invalidate` and `ak-refreshed` route to it; only `reset` clears the pointer.
 * The ROTATING device compensates: `runAKRotation` clears the pointer right
 * after storing the new one. The SURVIVING-device adoption path (`applyKeyring`)
 * must do the equivalent: without it, a device that has encoded once (warm
 * cache) stages the new keyring, persists primary "1" to IndexedDB — and keeps
 * uploading `__enc:v2:0:`, under precisely the DEK the revoked device retains,
 * until its context reloads.
 *
 * Two traps this spec deliberately avoids — do not "simplify" them away:
 *
 *   - The REVOKER cannot be the probe device: the pointer clear on the rotation
 *     path hides the bug there. The roles must be A (revoker), B (warmed
 *     survivor, the probe), C (revoked).
 *   - B must not navigate between warming and the probe write: `createTask`
 *     does a `page.goto('/tasks')`, and a navigation reloads the main-thread
 *     module state, which can mask the stale pointer. B is warmed via
 *     `createTask` once (the navigation happens BEFORE the warming encode) and
 *     the probe task is then created with direct clicks on the still-live page.
 *
 * Capability audit: NO adversary privileges — this is the benign multi-device
 * revocation flow plus a read-only Postgres oracle. That is what makes the
 * break severe: it fires deterministically in normal use, and A4 (the revoked
 * device, which retains DEK "0" forever) is handed every post-revocation write
 * from every warmed surviving device.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh attacks/stale-primary-after-adoption.spec.ts
 */

import {
  getEncryptionServerSnapshot,
  getTaskIds,
  waitForEncryptedSetting,
  waitForNewEncryptedTasks,
  waitForUserId,
} from '../db'
import { expect, test } from '../fixtures'
import {
  completeFirstDeviceSetup,
  createE2eeEmail,
  createTask,
  enableTasks,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  revokeTrustedDevice,
  trustAdditionalDevice,
  waitForTasksPreference,
} from '../helpers'

test.describe('C5 — stale primary after rotation adoption', () => {
  test('a surviving warmed device seals its next write under the rotated primary', async ({ browser, page }) => {
    // Three devices, two approvals and a revoke-rotation — well past the
    // default budget on a loaded runner.
    test.slow()

    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    await enableTasks(page)
    await waitForEncryptedSetting(userId, 'experimental_feature_tasks')

    // B: the surviving device whose encoder we warm. C: the device A revokes.
    const survivor = await trustAdditionalDevice(browser, page, { email, userId, profile: 'safari' })
    const doomed = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      // Warm B's encoder: one encode populates the codec's in-memory primary
      // pointer ("0"). createTask navigates B to /tasks first, so the warming
      // happens in the context that stays live for the rest of the test.
      await waitForTasksPreference(survivor.page, userId)
      const preWarmIds = await getTaskIds(userId)
      await createTask(survivor.page, `Warm the survivor ${crypto.randomUUID()}`)
      for (const row of await waitForNewEncryptedTasks(userId, preWarmIds)) {
        expect(row.item).toMatch(/^__enc:v2:0:/) // pre-rotation baseline, non-vacuous
      }

      // A revokes C → silent AK rotation + fresh primary DEK "1" on the server.
      await revokeTrustedDevice(page, doomed.label)
      await expect
        .poll(() => getEncryptionServerSnapshot(userId), { timeout: 30_000 })
        .toMatchObject({ primaryKeyId: '1' })

      // A writes a marker under the new primary; B RENDERING it proves B
      // fetched the rotated keyring and decrypted a `__enc:v2:1:` value —
      // adoption happened. The staged-DEK check pins that it also persisted.
      const preMarkerIds = await getTaskIds(userId)
      const marker = `New primary marker ${crypto.randomUUID()}`
      await createTask(page, marker)
      for (const row of await waitForNewEncryptedTasks(userId, preMarkerIds)) {
        expect(row.item).toMatch(/^__enc:v2:1:/) // the rotating device did move — isolates B's behavior
      }
      await expect(survivor.page.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => getEncryptionKeyNames(survivor.page), { timeout: 30_000 })
        .toEqual(expect.arrayContaining(['thunderbolt_dek_1']))

      // The probe: B creates a task WITHOUT navigating (direct clicks — see the
      // header trap note). B has adopted: dek_1 staged, primary "1" persisted.
      const preProbeIds = await getTaskIds(userId)
      const probeText = `After adoption ${crypto.randomUUID()}`
      await survivor.page.getByRole('button', { name: 'New Task' }).click()
      const taskInput = survivor.page.getByPlaceholder('Add a new task…')
      await taskInput.fill(probeText)
      await taskInput.press('Enter')
      await expect(survivor.page.getByText(probeText, { exact: true })).toBeVisible()

      // SECURE assertion: the surviving device's post-adoption write is sealed
      // under the rotated primary — not the DEK the revoked device retains.
      const probeRows = await waitForNewEncryptedTasks(userId, preProbeIds)
      expect(probeRows.length).toBeGreaterThan(0)
      for (const row of probeRows) {
        expect(row.item).toMatch(/^__enc:v2:1:/)
      }
    } finally {
      await survivor.context.close()
      await doomed.context.close()
    }
  })
})
