/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The passkey continuity seal (C2/C9, adversary A2). The passkey slot is an
 * anonymous envelope like the recovery slot, so a server could wrap its own AK
 * to the slot's public keys. **Claim: a sealed slot unlocks only the account's
 * own key lineage, and a missing or altered seal is refused before anything is
 * stored.** New passkeys are sealed; the seal survives AK rotations that keep
 * the slot and goes away with the passkey. A device that adopted keys unverified
 * cannot add a passkey.
 *
 * Ceremonies run for real against a Chrome virtual authenticator with PRF.
 *
 * Runs only with passkeys enabled, which changes every other spec's setup flow:
 *   E2E_PASSKEY_ENABLED=true bash scripts/run-e2ee-powersync.sh
 */

import type { BrowserContext, Page, Request } from '@playwright/test'
import { expect, test } from './fixtures'
import { getPasskeyContinuity, waitForDeviceState, waitForUserId } from './db'
import {
  addVirtualPasskeyAuthenticator,
  completeFirstDeviceSetup,
  createE2eeEmail,
  deviceLabels,
  finishAdditionalDeviceSetup,
  getDeviceId,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  overrideEncryptionMetadata,
  revokeTrustedDevice,
  seedLegacyRecoveryAccount,
  signOutDeletingData,
  startAdditionalDeviceSetup,
  startPhraseRecovery,
  submitRecoveryPhrase,
  trustAdditionalDevice,
  unverifiedMarker,
} from './helpers'

const refusal = "This passkey unlocked keys that don't belong to your account, so nothing was changed on this device."

/** Sign in and set up the first device, creating a passkey at the wizard's offer. */
const setUpWithPasskey = async (page: Page): Promise<{ email: string; userId: string; seal: string }> => {
  const email = createE2eeEmail()
  await loginViaConsumerOtp(page, email)
  const userId = await waitForUserId(email)
  await completeFirstDeviceSetup(page, 'Create passkey')
  const seal = await getPasskeyContinuity(userId)
  if (!seal) {
    throw new Error('A passkey created at setup must store a continuity seal')
  }
  return { email, userId, seal }
}

/** Wipe this device and sign back in, stopping at the approval step. */
const wipeAndSignBackIn = async (page: Page, email: string) => {
  await signOutDeletingData(page)
  await loginViaConsumerOtp(page, email)
  const dialog = await startAdditionalDeviceSetup(page)
  return { dialog, unlock: dialog.getByRole('button', { name: 'Unlock with passkey' }) }
}

/** Record every self-approval envelope this context posts. */
const recordEnvelopePosts = (context: BrowserContext): string[] => {
  const posts: string[] = []
  context.on('request', (request: Request) => {
    if (request.method() === 'POST' && /\/v1\/devices\/[^/]+\/envelope$/.test(request.url())) {
      posts.push(request.url())
    }
  })
  return posts
}

const expectVerifiedKeys = async (page: Page): Promise<void> => {
  const names = await getEncryptionKeyNames(page)
  expect(names).toContain('thunderbolt_ak')
  expect(names).not.toContain(unverifiedMarker)
}

test.describe('Passkey continuity', () => {
  test('enrolls a sealed passkey and unlocks a wiped device as verified', async ({ page }) => {
    await addVirtualPasskeyAuthenticator(page)
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const userId = await waitForUserId(email)
    await completeFirstDeviceSetup(page, 'Not now')
    expect(await getPasskeyContinuity(userId)).toBeNull()

    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const addDialog = page.getByRole('dialog', { name: 'Add a passkey' })
    await addDialog.getByRole('button', { name: 'Create passkey' }).click()
    await expect(addDialog).toBeHidden({ timeout: 30_000 })
    await expect.poll(() => getPasskeyContinuity(userId), { timeout: 30_000 }).not.toBeNull()

    const { unlock } = await wipeAndSignBackIn(page, email)
    await unlock.click()
    await finishAdditionalDeviceSetup(page)
    await expectVerifiedKeys(page)
    await page.goto('/settings/preferences')
    await expect(page.getByRole('button', { name: 'Change Recovery Phrase' })).toBeEnabled()
  })

  test('refuses a stripped or tampered seal before adopting anything', async ({ page, context }) => {
    await addVirtualPasskeyAuthenticator(page)
    const { email, userId, seal } = await setUpWithPasskey(page)
    const envelopePosts = recordEnvelopePosts(context)
    const { dialog, unlock } = await wipeAndSignBackIn(page, email)
    const deviceId = await getDeviceId(page)

    const tampered = `${seal[0] === 'A' ? 'B' : 'A'}${seal.slice(1)}`
    for (const servedSeal of [null, tampered]) {
      await context.unrouteAll({ behavior: 'wait' })
      await overrideEncryptionMetadata(context, { passkey_continuity: servedSeal })
      await unlock.click()
      await expect(dialog.getByText(refusal)).toBeVisible({ timeout: 30_000 })
      expect(await getEncryptionKeyNames(page)).not.toContain('thunderbolt_ak')
      expect(envelopePosts).toEqual([])
      await waitForDeviceState(userId, deviceId, (state) => !state.trusted && !state.hasEnvelope)
    }

    // Non-vacuity: once the server serves the real seal, the same passkey unlocks.
    await context.unrouteAll({ behavior: 'wait' })
    await unlock.click()
    await finishAdditionalDeviceSetup(page)
    await expectVerifiedKeys(page)
  })

  test('recovers from a cancelled passkey prompt', async ({ page }) => {
    await addVirtualPasskeyAuthenticator(page)
    const { email } = await setUpWithPasskey(page)
    const { unlock } = await wipeAndSignBackIn(page, email)

    // The user dismisses the system prompt: the browser rejects the ceremony
    // with NotAllowedError, once.
    await page.evaluate(() => {
      const { credentials } = navigator
      const get = credentials.get.bind(credentials)
      credentials.get = async () => {
        credentials.get = get
        throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')
      }
    })
    await unlock.click()
    await expect(unlock).toBeEnabled({ timeout: 30_000 })
    expect(await getEncryptionKeyNames(page)).not.toContain('thunderbolt_ak')

    await unlock.click()
    await finishAdditionalDeviceSetup(page)
    await expectVerifiedKeys(page)
  })

  test('keeps the passkey seal across a device revocation', async ({ page, browser }) => {
    await addVirtualPasskeyAuthenticator(page)
    const { email, userId, seal } = await setUpWithPasskey(page)

    const other = await trustAdditionalDevice(browser, page, { email, userId, profile: 'firefox' })
    try {
      await revokeTrustedDevice(page, deviceLabels.firefox)
      await waitForDeviceState(userId, other.deviceId, (state) => state.revokedAt !== null)
    } finally {
      await other.context.close()
    }
    expect(await getPasskeyContinuity(userId)).toBe(seal)

    const { unlock } = await wipeAndSignBackIn(page, email)
    await unlock.click()
    await finishAdditionalDeviceSetup(page)
    await expectVerifiedKeys(page)
  })

  test('clears the passkey seal when the passkey is removed', async ({ page }) => {
    await addVirtualPasskeyAuthenticator(page)
    const { userId } = await setUpWithPasskey(page)

    await page.goto('/settings/preferences')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    const confirmation = page.getByRole('alertdialog').filter({ hasText: 'Remove your passkey?' })
    await confirmation.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(confirmation).toBeHidden({ timeout: 30_000 })
    await expect.poll(() => getPasskeyContinuity(userId), { timeout: 30_000 }).toBeNull()
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  })

  test('blocks passkey enrollment on an unverified device', async ({ page, context }) => {
    const registrations: string[] = []
    context.on('request', (request) => {
      if (request.url().includes('/passkey/generate-register-options')) {
        registrations.push(request.url())
      }
    })
    await addVirtualPasskeyAuthenticator(page)
    const email = createE2eeEmail()
    await loginViaConsumerOtp(page, email)
    const account = await seedLegacyRecoveryAccount(await waitForUserId(email))
    const dialog = await startPhraseRecovery(page)
    await submitRecoveryPhrase(dialog, account.phrase)
    // No passkey offer here: the device just adopted keys it couldn't verify.
    await finishAdditionalDeviceSetup(page)
    expect(await getEncryptionKeyNames(page)).toContain(unverifiedMarker)

    await page.goto('/settings/preferences')
    const add = page.getByRole('button', { name: 'Add', exact: true })
    await expect(add).toBeDisabled({ timeout: 30_000 })
    await expect(add).toHaveAccessibleDescription(/couldn't be verified/)
    expect(registrations).toEqual([])
  })
})
