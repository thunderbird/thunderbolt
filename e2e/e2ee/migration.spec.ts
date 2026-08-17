/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * v1 → v2 data-preserving migration (the centerpiece of Track H).
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh
 *
 * The suite seeds a REAL legacy v1 account (byte-identical to what a shipped v1
 * build produced: hybrid CK envelopes + `__enc:<iv>:<ct>` no-AAD rows across
 * representative tables) using the app's own crypto primitives, then ships this
 * v2 build and proves the "absorb + permanent dual-read" model (plan §2.3):
 *
 *  - the migrator absorbs the CK as the reserved `"v1"` DEK slot, mints primary
 *    DEK `"0"`, and CAS-flips scheme_version 1→2;
 *  - legacy rows STILL decrypt on the migrator, on a later-joining follower, and
 *    after a fresh recovery-from-phrase (dual-read `"v1"` slot, no AAD);
 *  - a follower that joins AFTER the flip reads BOTH formats (v1 legacy + v2 new);
 *  - two concurrent migrators resolve by CAS — one wins, the loser follows;
 *  - a below-min client is 426'd on the sync-token route (hard-cutover guard).
 */

import {
  getEncryptionServerSnapshot,
  getSchemeVersion,
  getTaskIds,
  waitForDeviceKeys,
  waitForDeviceState,
  waitForNewEncryptedTasks,
  waitForSchemeV2,
  waitForUserId,
} from './db'
import { expect, test } from './fixtures'
import {
  createE2eeEmail,
  createIsolatedDevice,
  createTask,
  enableTasks,
  finishAdditionalDeviceSetup,
  getDeviceId,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  registerDeviceOnly,
  runSeamlessMigration,
  seedV1Account,
  startAdditionalDeviceSetup,
  waitForTasksPreference,
} from './helpers'

// Must match playwright.e2ee.config.ts. The gated backend pins MIN_APP_VERSION
// above this build so the version gate is genuinely tripped; the main backend is
// ungated (so the migration flows themselves are never 426'd).
const mainBackendPort = 8004
const gatedBackendPort = 8005

test.describe('PowerSync E2EE v1 → v2 migration', () => {
  test('preserves legacy data across migrator, a later-joining follower, and fresh recovery', async ({
    browser,
    page,
  }) => {
    const email = createE2eeEmail()
    const postFlipTaskText = `Post-flip v2 task ${crypto.randomUUID()}`

    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)

    // Register this device (transport key pair + server public keys) WITHOUT
    // setting up v2, then seed a real legacy v1 account around those keys.
    await registerDeviceOnly(page)
    const [migratorKeys] = await waitForDeviceKeys(userId, 1)
    // The scheme-1 encryption_metadata row is created asynchronously by device
    // registration; poll rather than read once so a slow CI runner can't race
    // ahead of the write and see null.
    await expect.poll(() => getSchemeVersion(userId), { timeout: 15_000 }).toBe(1)
    const seeded = await seedV1Account(userId, [migratorKeys])

    // The seamless upgrade: absorb CK as "v1", mint primary "0", CAS-flip.
    const newRecoveryPhrase = await runSeamlessMigration(page)
    expect(newRecoveryPhrase.split(/\s+/)).toHaveLength(24)

    await waitForSchemeV2(userId, ['0', 'v1'])
    const snapshot = await getEncryptionServerSnapshot(userId)
    expect(snapshot.schemeVersion).toBe(2)
    expect(snapshot.primaryKeyId).toBe('0')
    expect(Object.keys(snapshot.wrappedKeys).sort()).toEqual(['0', 'v1'])

    await expect
      .poll(() => getEncryptionKeyNames(page))
      .toEqual(expect.arrayContaining(['thunderbolt_ak', 'thunderbolt_dek_0', 'thunderbolt_dek_v1']))

    // (a) Legacy rows still decrypt on the migrator via the dual-read "v1" slot.
    await enableTasks(page)
    await page.goto('/tasks')
    await expect(page.getByText(seeded.taskText, { exact: true })).toBeVisible({ timeout: 30_000 })

    // The migrator now writes a NEW post-flip row — it MUST be v2 under "0".
    const taskIdsBeforeWrite = await getTaskIds(userId)
    await createTask(page, postFlipTaskText)
    const newRows = await waitForNewEncryptedTasks(userId, taskIdsBeforeWrite)
    for (const row of newRows) {
      expect(row.item).toMatch(/^__enc:v2:0:/)
    }

    // (b) A follower that joins AFTER the flip reads BOTH formats.
    const follower = await createIsolatedDevice(browser, 'firefox')
    try {
      await loginViaConsumerOtp(follower.page, email)
      await startAdditionalDeviceSetup(follower.page)
      const followerId = await getDeviceId(follower.page)
      await waitForDeviceState(userId, followerId, (state) => state.approvalPending)

      const notification = page.getByRole('dialog').filter({ hasText: 'New device waiting' })
      await expect(notification).toBeVisible({ timeout: 30_000 })
      await notification.getByRole('button', { name: 'Approve' }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click()
      await waitForDeviceState(userId, followerId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(follower.page)

      // Follower staged the keyring including the "v1" slot (continuity check passed).
      await expect
        .poll(() => getEncryptionKeyNames(follower.page))
        .toEqual(expect.arrayContaining(['thunderbolt_ak', 'thunderbolt_dek_0', 'thunderbolt_dek_v1']))

      await waitForTasksPreference(follower.page)
      await follower.page.goto('/tasks')
      await expect(follower.page.getByText(seeded.taskText, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(follower.page.getByText(postFlipTaskText, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await follower.context.close()
    }

    // (c) A fresh recovery-from-phrase device decrypts the legacy data too.
    const recovered = await createIsolatedDevice(browser, 'safari')
    try {
      await loginViaConsumerOtp(recovered.page, email)
      const setupDialog = await startAdditionalDeviceSetup(recovered.page)
      const recoveredId = await getDeviceId(recovered.page)
      await setupDialog.getByRole('button', { name: 'Use my recovery key' }).click()
      await setupDialog.getByPlaceholder('word1 word2 word3 ...').fill(newRecoveryPhrase)
      await setupDialog.getByRole('button', { name: 'Submit' }).click()
      await waitForDeviceState(userId, recoveredId, (state) => state.trusted && state.hasEnvelope)
      await finishAdditionalDeviceSetup(recovered.page)

      await waitForTasksPreference(recovered.page)
      await recovered.page.goto('/tasks')
      await expect(recovered.page.getByText(seeded.taskText, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await recovered.context.close()
    }
  })

  test('resolves concurrent migrators via CAS — one wins, the loser follows', async ({ browser, page }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await registerDeviceOnly(page)

    const second = await createIsolatedDevice(browser, 'firefox')
    try {
      await loginViaConsumerOtp(second.page, email)
      await registerDeviceOnly(second.page)

      // Both devices are trusted and hold the SAME CK (an envelope each), so both
      // are migrator-eligible — the CAS on scheme_version decides the winner.
      const deviceKeys = await waitForDeviceKeys(userId, 2)
      const seeded = await seedV1Account(userId, deviceKeys)

      // Kick both app-init migration checks concurrently via reload; the winner
      // flips (dispatches the new recovery phrase), the loser 409s and follows.
      await Promise.all([page.reload(), second.page.reload()])

      // Exactly one upgrade wins: the account flips once to a single keyring.
      await waitForSchemeV2(userId, ['0', 'v1'])
      const snapshot = await getEncryptionServerSnapshot(userId)
      expect(snapshot.schemeVersion).toBe(2)
      expect(Object.keys(snapshot.wrappedKeys).sort()).toEqual(['0', 'v1'])
      // A pure upgrade — no AK rotation happened as part of losing the race.
      expect(snapshot.keyVersion).toBe(1)

      // Both devices converge to a readable state (winner migrated, loser followed).
      for (const device of [page, second.page]) {
        await expect
          .poll(() => getEncryptionKeyNames(device))
          .toEqual(expect.arrayContaining(['thunderbolt_ak', 'thunderbolt_dek_0', 'thunderbolt_dek_v1']))
      }

      await enableTasks(page)
      await page.goto('/tasks')
      await expect(page.getByText(seeded.taskText, { exact: true })).toBeVisible({ timeout: 30_000 })
      await waitForTasksPreference(second.page)
      await second.page.goto('/tasks')
      await expect(second.page.getByText(seeded.taskText, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await second.context.close()
    }
  })

  test('426s a below-min client on the sync-token route (hard-cutover guard)', async ({ request }) => {
    const gatedToken = `http://localhost:${gatedBackendPort}/v1/powersync/token`
    const mainToken = `http://localhost:${mainBackendPort}/v1/powersync/token`

    // The version gate runs BEFORE auth (fail-closed), so these need no session.
    const belowMin = await request.get(gatedToken, { headers: { 'X-App-Version': '0.0.1' } })
    expect(belowMin.status()).toBe(426)

    const missingHeader = await request.get(gatedToken)
    expect(missingHeader.status()).toBe(426)

    // A version at/above the server minimum clears the gate (then fails auth, not 426).
    const atMin = await request.get(gatedToken, { headers: { 'X-App-Version': '99.0.0' } })
    expect(atMin.status()).not.toBe(426)

    // Exempt route is never gated, even below-min → proves it's the gate, not the route.
    const health = await request.get(`http://localhost:${gatedBackendPort}/v1/health`, {
      headers: { 'X-App-Version': '0.0.1' },
    })
    expect(health.status()).not.toBe(426)

    // The ungated main backend never 426s the same below-min request.
    const ungated = await request.get(mainToken, { headers: { 'X-App-Version': '0.0.1' } })
    expect(ungated.status()).not.toBe(426)
  })
})
