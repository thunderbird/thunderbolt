/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A device that recovered with a pre-seal phrase. The phrase still works, as
 * compatibility trust-on-first-use, but nothing proves the keys it opened are
 * the account's own, so the device is marked unverified.
 * **Claim: an unverified device keeps its session and data but cannot extend
 * trust in those keys (no device approval, no CLI sign-in approval, no phrase
 * change), and the mark stays after the account gets a seal.** Denying still
 * works, since it narrows trust.
 *
 * The account is seeded in Postgres the way a pre-seal client left it
 * (untagged `kdf_salt`, no seal), and the device recovers through the real
 * wizard. The test writes nothing to its key store.
 * `passkey-continuity.spec.ts` covers passkey enrollment on such a device, which
 * needs the passkey-enabled run.
 *
 * Requires the PowerSync + Postgres harness. Run with:
 *   bash scripts/run-e2ee-powersync.sh unverified-device.spec.ts
 */

import type { Request } from '@playwright/test'
import { expect, test } from './fixtures'
import { waitForDeviceState, waitForUserId } from './db'
import {
  backendBaseUrl,
  createE2eeEmail,
  createIsolatedDevice,
  deviceLabels,
  finishAdditionalDeviceSetup,
  getDeviceId,
  getEncryptionKeyNames,
  loginViaConsumerOtp,
  recoveryStatusCard,
  securityNotice,
  seedLegacyRecoveryAccount,
  startAdditionalDeviceSetup,
  startPhraseRecovery,
  submitRecoveryPhrase,
  unverifiedMarker,
  type DeviceSession,
  type LegacyRecoveryAccount,
} from './helpers'

const blockedCopy = /couldn't be verified/

/** Requests that would extend trust: approving a device or a CLI sign-in, or rotating the AK. */
const isTrustExtension = (request: Request): boolean =>
  (request.method() === 'POST' && /\/v1\/devices\/[^/]+\/envelope$/.test(request.url())) ||
  request.url().endsWith('/device/approve') ||
  request.url().endsWith('/v1/encryption/rotate')

test.describe.serial('A device that recovered with a phrase from before the seal', () => {
  // Shared across the serial tests: one real legacy recovery, then each refusal.
  let email: string
  let userId: string
  let account: LegacyRecoveryAccount
  let device: DeviceSession
  let pending: DeviceSession
  const trustExtensions: string[] = []

  test.beforeAll(async ({ browser }) => {
    email = createE2eeEmail()
    device = await createIsolatedDevice(browser, 'firefox')
    await loginViaConsumerOtp(device.page, email)
    userId = await waitForUserId(email)
    account = await seedLegacyRecoveryAccount(userId)

    const dialog = await startPhraseRecovery(device.page)
    await expect(dialog.getByText(/This recovery phrase was created before a security update/)).toBeVisible()
    await submitRecoveryPhrase(dialog, account.phrase)
    await finishAdditionalDeviceSetup(device.page)
    await waitForDeviceState(userId, await getDeviceId(device.page), (state) => state.trusted && state.hasEnvelope)
    // Start recording now: the recovery's envelope above is the adoption itself, not a trust extension.
    device.context.on('request', (request) => {
      if (isTrustExtension(request)) {
        trustExtensions.push(`${request.method()} ${request.url()}`)
      }
    })
  })

  test.afterAll(async () => {
    await pending?.context.close()
    await device?.context.close()
  })

  test.afterEach(() => {
    expect(trustExtensions).toEqual([])
  })

  test('marks the device unverified and keeps the mark once the account is sealed', async () => {
    const { page } = device
    expect(await getEncryptionKeyNames(page)).toContain(unverifiedMarker)

    await page.goto('/settings/preferences')
    const card = recoveryStatusCard(page)
    await expect(card.getByText("This device couldn't be verified")).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText(/sign out with "Delete data from device"/)).toBeVisible()
    await expect(card.getByText('Unverified', { exact: true })).toBeVisible()
    await expect(card.getByText('Needs update', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Settings, action needed' })).toBeVisible()
    await expect(securityNotice(page)).toBeHidden()

    // A trusted device sealing the phrase changes the account, not this device's keys.
    await account.seal()
    await page.reload()
    await expect(card.getByText('Up to date', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText("This device couldn't be verified")).toBeVisible()
    await expect(page.getByRole('button', { name: 'Settings, action needed' })).toBeVisible()
    expect(await getEncryptionKeyNames(page)).toContain(unverifiedMarker)
  })

  test('refuses to approve a pending device', async ({ browser }) => {
    pending = await createIsolatedDevice(browser, 'safari')
    await loginViaConsumerOtp(pending.page, email)
    await startAdditionalDeviceSetup(pending.page)
    const pendingId = await getDeviceId(pending.page)
    await waitForDeviceState(userId, pendingId, (state) => state.approvalPending)

    const { page } = device
    const notification = page.getByRole('dialog').filter({ hasText: 'New device waiting' })
    await expect(notification).toBeVisible({ timeout: 30_000 })
    const approve = notification.getByRole('button', { name: 'Approve' })
    await expect(approve).toBeDisabled()
    await expect(approve).toHaveAccessibleDescription(blockedCopy)

    // It can't approve, so it may set the prompt aside; the Devices row stays.
    await page.goto('/settings/devices')
    await notification.getByRole('button', { name: 'Close' }).click({ timeout: 30_000 })
    await expect(notification).toBeHidden()
    const rowApprove = page.getByRole('button', { name: `Approve ${deviceLabels.safari}` })
    await expect(rowApprove).toBeDisabled()
    await expect(rowApprove).toHaveAccessibleDescription(blockedCopy)

    await page.waitForTimeout(10_000)
    await waitForDeviceState(userId, pendingId, (state) => state.approvalPending && !state.trusted)
  })

  test('keeps deny working', async () => {
    const { page } = device
    await page.getByRole('button', { name: `Deny ${deviceLabels.safari}` }).click()
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation.getByText('Deny this device?')).toBeVisible()
    await confirmation.getByRole('button', { name: 'Deny' }).click()

    const pendingId = await getDeviceId(pending.page)
    await waitForDeviceState(userId, pendingId, (state) => !state.trusted && !state.approvalPending)
    await expect(pending.page.getByText('Request denied', { exact: true })).toBeVisible({ timeout: 30_000 })
  })

  test('refuses to approve a CLI sign-in', async () => {
    const response = await fetch(`${backendBaseUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'thunderbolt-cli' }),
    })
    expect(response.ok).toBe(true)
    const { user_code: userCode } = (await response.json()) as { user_code: string }

    const { page } = device
    await page.goto(`/device?user_code=${encodeURIComponent(userCode)}`)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Approve CLI sign-in?')).toBeVisible({ timeout: 30_000 })
    const approve = dialog.getByRole('button', { name: 'Approve' })
    await expect(approve).toBeDisabled()
    await expect(approve).toHaveAccessibleDescription(blockedCopy)
  })

  test('blocks phrase changes', async () => {
    const { page } = device
    await page.goto('/settings/preferences')
    const change = page.getByRole('button', { name: 'Change Recovery Phrase' })
    await expect(change).toBeDisabled({ timeout: 30_000 })
    await expect(change).toHaveAccessibleDescription(blockedCopy)
    await expect(recoveryStatusCard(page).getByRole('button', { name: /Update/ })).toHaveCount(0)
  })
})
