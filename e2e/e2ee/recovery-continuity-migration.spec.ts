/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Migrating a pre-seal account to the recovery continuity seal. A trusted device
 * sees a banner, a Settings marker and a Preferences card, and replaces the
 * phrase; the new phrase carries a seal and a tagged `kdf_salt`, and a wiped
 * device recovers with it as verified. A device that isn't approved yet sees only
 * the card, and a device about to recover with a pre-seal phrase is warned first.
 *
 * The pre-seal account is a freshly set-up one with its seal cleared. The
 * migration UI reacts to the missing seal, and the trusted device holds real keys
 * for the account. `unverified-device.spec.ts` covers a phrase that really
 * predates the seal.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh recovery-continuity-migration.spec.ts
 */

import { expect, test } from './fixtures'
import { getKdfSalt, getRecoveryContinuity, setRecoveryContinuity, waitForStepUpOtp, waitForUserId } from './db'
import {
  completeFirstDeviceSetup,
  confirmPhraseUpdate,
  createE2eeEmail,
  createIsolatedDevice,
  finishAdditionalDeviceSetup,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  overrideEncryptionMetadata,
  recoveryStatusCard,
  securityNotice,
  startPhraseRecovery,
  submitRecoveryPhrase,
  trustAdditionalDevice,
  unverifiedMarker,
} from './helpers'
import type { Page } from '@playwright/test'

const legacyWarning = /This recovery phrase was created before a security update/

/** Sign in, set up the first device, then drop the seal: the account a pre-seal client left. */
const setUpAccountWithoutSeal = async (page: Page): Promise<{ email: string; userId: string }> => {
  const email = createE2eeEmail()
  await loginViaConsumerOtp(page, email)
  const userId = await waitForUserId(email)
  await completeFirstDeviceSetup(page)
  await setRecoveryContinuity(userId, null)
  return { email, userId }
}

/** The seal is back, and the salt carries the continuity tag. */
const expectSealed = async (userId: string): Promise<void> => {
  await expect.poll(() => getRecoveryContinuity(userId), { timeout: 30_000 }).not.toBeNull()
  const salt = Buffer.from(await getKdfSalt(userId), 'base64')
  expect(salt.subarray(0, 8).toString()).toBe('tb-rc-v1')
}

test.describe('Recovery continuity migration', () => {
  test('migrates a trusted device from the banner and recovers with the new phrase', async ({ page, browser }) => {
    const { email, userId } = await setUpAccountWithoutSeal(page)

    await page.goto('/settings/preferences')
    const banner = securityNotice(page)
    await expect(banner.getByText('Update your recovery phrase.')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Settings, action needed' })).toBeVisible()
    await expect(recoveryStatusCard(page).getByText('Recovery phrase needs an update')).toBeVisible()

    await banner.getByRole('button', { name: 'Update now' }).click()
    const newPhrase = await confirmPhraseUpdate(page, email)
    await expectSealed(userId)
    await expect(banner.getByText('Recovery phrase updated.')).toBeVisible()

    const fresh = await createIsolatedDevice(browser, 'safari')
    try {
      await loginViaConsumerOtp(fresh.page, email)
      const dialog = await startPhraseRecovery(fresh.page)
      await expect(dialog.getByText(legacyWarning)).toBeHidden()
      await submitRecoveryPhrase(dialog, newPhrase)
      await finishAdditionalDeviceSetup(fresh.page)
      expect(await getEncryptionKeyNames(fresh.page)).not.toContain(unverifiedMarker)
      await expect(securityNotice(fresh.page)).toBeHidden()
    } finally {
      await fresh.context.close()
    }
  })

  test('stops an open flow when another device completes the migration', async ({ page, browser }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page)
    const other = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      await setRecoveryContinuity(userId, null)
      await page.goto('/settings/preferences')
      await securityNotice(page).getByRole('button', { name: 'Update now' }).click({ timeout: 30_000 })
      await expect(page.getByRole('alertdialog').getByText('Update your recovery phrase?')).toBeVisible()

      await other.page.goto('/settings/preferences')
      await securityNotice(other.page).getByRole('button', { name: 'Update now' }).click({ timeout: 30_000 })
      await confirmPhraseUpdate(other.page, email)
      const seal = await getRecoveryContinuity(userId)
      expect(seal).not.toBeNull()

      // The first device still thinks the update is needed; the re-check before
      // rotating sees the seal and closes the flow without minting a phrase.
      await page.getByRole('alertdialog').getByRole('button', { name: 'Send code' }).click()
      const codeDialog = page.getByRole('alertdialog')
      await expect(codeDialog.getByText('Enter your verification code')).toBeVisible()
      await codeDialog.locator('[data-slot="input-otp"]').fill('00000000')
      await expect(codeDialog).toBeHidden({ timeout: 30_000 })
      await expect(page.getByRole('dialog').filter({ hasText: 'Save your new recovery phrase' })).toBeHidden()
      await expect(securityNotice(page).getByText('Your recovery phrase was updated on another device.')).toBeVisible()
      expect(await getRecoveryContinuity(userId)).toBe(seal)
    } finally {
      await other.context.close()
    }
  })

  test('shows only the card on an untrusted device', async ({ page, browser }) => {
    const { email } = await setUpAccountWithoutSeal(page)

    const pending = await createIsolatedDevice(browser, 'windows')
    try {
      await loginViaConsumerOtp(pending.page, email)
      await pending.page.goto('/settings/preferences')
      const card = recoveryStatusCard(pending.page)
      await expect(card.getByText('Recovery phrase needs an update')).toBeVisible({ timeout: 30_000 })
      await expect(card.getByText('Not approved yet')).toBeVisible()
      // An unapproved device gets no sync token, so a device list here would always be empty.
      await expect(card.getByRole('button', { name: 'View devices' })).toBeHidden()
      await expect(card.getByRole('button', { name: 'Update recovery phrase' })).toBeHidden()
      await expect(securityNotice(pending.page)).toBeHidden()
    } finally {
      await pending.context.close()
    }
  })

  test('keeps the warning offline and retries after reconnecting', async ({ page, context }) => {
    const { email, userId } = await setUpAccountWithoutSeal(page)
    await page.goto('/settings/preferences')
    const banner = securityNotice(page)
    const updateNow = banner.getByRole('button', { name: 'Update now' })
    await expect(updateNow).toBeEnabled({ timeout: 30_000 })

    await context.setOffline(true)
    await expect(banner.getByText("You're offline. You can update it once you reconnect.")).toBeVisible()
    await expect(updateNow).toBeDisabled()

    await context.setOffline(false)
    await expect(updateNow).toBeEnabled()
    await updateNow.click()
    await confirmPhraseUpdate(page, email)
    await expectSealed(userId)
  })

  test('retries a rotation after a server error', async ({ page, context }) => {
    const { email, userId } = await setUpAccountWithoutSeal(page)
    const rotations: string[] = []
    await context.route('**/v1/encryption/rotate', async (route) => {
      rotations.push(route.request().method())
      if (rotations.length === 1) {
        await route.fulfill({ status: 500, json: { error: 'Internal Server Error' } })
        return
      }
      await route.fallback()
    })

    await page.goto('/settings/preferences')
    await securityNotice(page).getByRole('button', { name: 'Update now' }).click({ timeout: 30_000 })
    const confirmation = page.getByRole('alertdialog')
    await confirmation.getByRole('button', { name: 'Send code' }).click()
    const codeDialog = page.getByRole('alertdialog')
    await expect(codeDialog.getByText('Enter your verification code')).toBeVisible()
    await codeDialog.locator('[data-slot="input-otp"]').fill(await waitForStepUpOtp(email))

    // The failed attempt keeps the code dialog open with the same code for a retry.
    await expect.poll(() => rotations.length).toBe(1)
    const retry = codeDialog.getByRole('button', { name: 'Generate new phrase' })
    await expect(retry).toBeEnabled()
    expect(await getRecoveryContinuity(userId)).toBeNull()

    await retry.click()
    const saved = page.getByRole('dialog').filter({ hasText: 'Save your new recovery phrase' })
    await expect(saved.getByRole('region', { name: 'Recovery phrase' })).toBeVisible({ timeout: 30_000 })
    await saved.getByRole('checkbox').click()
    await saved.getByRole('button', { name: 'Done' }).click()
    await expectSealed(userId)
    expect(rotations).toHaveLength(2)
  })

  test('warns before a legacy recovery', async ({ page, browser }) => {
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    await completeFirstDeviceSetup(page)

    const recovering = await createIsolatedDevice(browser, 'safari')
    try {
      // The served salt lacks the continuity tag, as on a pre-seal account.
      await overrideEncryptionMetadata(recovering.context, { kdf_salt: Buffer.alloc(32, 7).toString('base64') })
      await loginViaConsumerOtp(recovering.page, email)
      const dialog = await startPhraseRecovery(recovering.page)
      await expect(dialog.getByText(legacyWarning)).toBeVisible()
    } finally {
      await recovering.context.close()
    }
  })
})
