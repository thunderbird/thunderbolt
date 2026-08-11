/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { getCurrentOtp, waitForOtp } from './db'

type DeviceProfile = 'firefox' | 'safari' | 'windows'

export type DeviceSession = {
  context: BrowserContext
  page: Page
}

const deviceUserAgents: Record<DeviceProfile, string> = {
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
}
const otpRequestTimes = new Map<string, number>()

/** Generate an auto-approved identity unique to this isolated E2EE stack. */
export const createE2eeEmail = (): string => `playwright-e2ee-${crypto.randomUUID()}@e2e.test`

/** Sign in through the real consumer waitlist and OTP browser flow. */
export const loginViaConsumerOtp = async (page: Page, email: string): Promise<void> => {
  await page.goto('/')

  const emailInput = page.getByPlaceholder('Email')
  await expect(emailInput).toBeVisible()
  const previousOtp = await getCurrentOtp(email)
  const previousRequestAt = otpRequestTimes.get(email)
  const cooldownRemaining = previousRequestAt ? 15_250 - (Date.now() - previousRequestAt) : 0
  if (cooldownRemaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, cooldownRemaining))
  }
  await emailInput.fill(email)
  otpRequestTimes.set(email, Date.now())
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Check your email', { exact: true })).toBeVisible()

  const otp = await waitForOtp(email, previousOtp)
  await page.locator('[data-slot="input-otp"]').fill(otp)
  await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
}

/** Create an isolated browser context whose user agent gives the device a stable display name. */
export const createIsolatedDevice = async (browser: Browser, profile: DeviceProfile): Promise<DeviceSession> => {
  const context = await browser.newContext({
    baseURL: 'http://localhost:1423',
    permissions: ['clipboard-read', 'clipboard-write'],
    userAgent: deviceUserAgents[profile],
  })
  return { context, page: await context.newPage() }
}

/** Read the persistent device identifier assigned to this browser context. */
export const getDeviceId = async (page: Page): Promise<string> => {
  const deviceId = await page.evaluate(() => localStorage.getItem('thunderbolt_device_id'))
  if (!deviceId) {
    throw new Error('Browser device ID was not initialized')
  }
  return deviceId
}

/** Complete first-device E2EE setup and return the one-time recovery phrase. */
export const completeFirstDeviceSetup = async (page: Page): Promise<string> => {
  await page.goto('/settings/preferences')
  const syncSwitch = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
  await expect(syncSwitch).toBeVisible()
  await syncSwitch.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Set up sync', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByText('First device setup', { exact: true })).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Continue' }).click()

  const recoveryRegion = dialog.getByRole('region', { name: 'Recovery phrase' })
  await expect(recoveryRegion).toBeVisible({ timeout: 30_000 })
  const recoveryPhrase = (await recoveryRegion.innerText()).trim()
  expect(recoveryPhrase.split(/\s+/)).toHaveLength(24)

  await dialog.getByRole('checkbox').click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expect(syncSwitch).toBeChecked()
  return recoveryPhrase
}

/** Register an additional device and stop at the approval/recovery choice. */
export const startAdditionalDeviceSetup = async (page: Page): Promise<Locator> => {
  await page.goto('/settings/preferences')
  const syncSwitch = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
  await expect(syncSwitch).toBeVisible()
  await syncSwitch.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Set up sync', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByText('Approve this device', { exact: true })).toBeVisible({ timeout: 30_000 })
  return dialog
}

/** Finish an approved or recovered additional-device wizard. */
export const finishAdditionalDeviceSetup = async (page: Page): Promise<void> => {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText("You're all set!", { exact: true })).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('switch', { name: 'Sync This Device With Cloud' })).toBeChecked()
}

/** Read a one-time recovery phrase from a setup or rotation dialog. */
export const readRecoveryPhrase = async (dialog: Locator): Promise<string> => {
  const recoveryRegion = dialog.getByRole('region', { name: 'Recovery phrase' })
  await expect(recoveryRegion).toBeVisible({ timeout: 30_000 })
  const recoveryPhrase = (await recoveryRegion.innerText()).trim()
  expect(recoveryPhrase.split(/\s+/)).toHaveLength(24)
  return recoveryPhrase
}

/** Enable the Tasks preview, including its telemetry-consent branch when configured. */
export const enableTasks = async (page: Page): Promise<void> => {
  await page.goto('/settings/preferences')
  const tasksSwitch = page.getByRole('switch', { name: 'Tasks' })
  await expect(tasksSwitch).toBeVisible()
  if (!(await tasksSwitch.isChecked())) {
    await tasksSwitch.click()
    const telemetryDialog = page.getByRole('alertdialog', { name: 'Telemetry Required' })
    if (await telemetryDialog.isVisible().catch(() => false)) {
      await telemetryDialog.getByRole('button', { name: 'Enable Telemetry' }).click()
      await expect(telemetryDialog).toBeHidden()
    }
  }
  await expect(tasksSwitch)
    .toBeChecked({ timeout: 3_000 })
    .catch(async () => {
      await tasksSwitch.click()
    })
  await expect(tasksSwitch).toBeChecked()
}

/** Wait until the encrypted Tasks preference has downloaded to a newly approved device. */
export const waitForTasksPreference = async (page: Page): Promise<void> => {
  await page.goto('/settings/preferences')
  await expect(page.getByRole('switch', { name: 'Tasks' })).toBeChecked({ timeout: 30_000 })
}

/** List the logical E2EE key names stored in the browser's IndexedDB keyring. */
export const getEncryptionKeyNames = async (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const databases = await indexedDB.databases()
    if (!databases.some((database) => database.name === 'thunderbolt-keys')) {
      return []
    }
    const request = indexedDB.open('thunderbolt-keys')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('keys', 'readonly')
    const keysRequest = transaction.objectStore('keys').getAllKeys()
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      keysRequest.onsuccess = () => resolve(keysRequest.result)
      keysRequest.onerror = () => reject(keysRequest.error)
    })
    database.close()
    return keys.map(String).sort()
  })

/** Create a task through the user-visible form. */
export const createTask = async (page: Page, taskText: string): Promise<void> => {
  await page.goto('/tasks')
  await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()
  await page.getByRole('button', { name: 'New Task' }).click()
  const taskInput = page.getByPlaceholder('Add a new task...')
  await taskInput.fill(taskText)
  await taskInput.press('Enter')
  await expect(page.getByText(taskText, { exact: true })).toBeVisible()
}

/** Sign out through the account menu while preserving the local SQLite data. */
export const signOutKeepingData = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('button', { name: 'Log out' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Log out' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByPlaceholder('Email')).toBeVisible({ timeout: 30_000 })
}
