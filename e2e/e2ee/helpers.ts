/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
// The v1 seed reuses the app's REAL crypto primitives (single source of truth
// for the hybrid-envelope byte layout + AES-GCM wire format), so a seeded legacy
// account is byte-identical to one a shipped v1 build would have produced. These
// primitives are DOM/IndexedDB-free (WebCrypto + @noble only), so they run in the
// Playwright Node process. Absorption on the migrator (`unwrapLegacyCK`) shares
// the same envelope derivation, which is what makes the round-trip real.
import { encrypt, importMlKemPublicKey, importPublicKey, wrapAK } from '../../src/crypto/primitives'
import {
  getCurrentOtp,
  seedV1ChatThread,
  seedV1Envelope,
  seedV1Metadata,
  seedV1Setting,
  seedV1Task,
  trustDevice,
  waitForOtp,
  type DeviceKeys,
} from './db'

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

export const createE2eeEmail = (): string => `playwright-e2ee-${crypto.randomUUID()}@e2e.test`

export const loginViaConsumerOtp = async (page: Page, email: string): Promise<void> => {
  await page.goto('/')

  const emailInput = page.getByPlaceholder('Email')
  // First app boot has to initialize the local DB before the sign-in surface
  // renders; give it a generous ceiling for a cold CI runner (matches the
  // additional-device login wait below).
  await expect(emailInput).toBeVisible({ timeout: 30_000 })
  const previousOtp = await getCurrentOtp(email)
  const previousRequestAt = otpRequestTimes.get(email)
  const cooldownRemaining = previousRequestAt ? 15_250 - (Date.now() - previousRequestAt) : 0
  if (cooldownRemaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, cooldownRemaining))
  }
  await emailInput.fill(email)
  otpRequestTimes.set(email, Date.now())
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Check your email', { exact: true })).toBeVisible({ timeout: 30_000 })

  const otp = await waitForOtp(email, previousOtp)
  await page.locator('[data-slot="input-otp"]').fill(otp)
  await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
}

export const createIsolatedDevice = async (browser: Browser, profile: DeviceProfile): Promise<DeviceSession> => {
  const context = await browser.newContext({
    baseURL: 'http://localhost:1423',
    permissions: ['clipboard-read', 'clipboard-write'],
    userAgent: deviceUserAgents[profile],
  })
  return { context, page: await context.newPage() }
}

export const getDeviceId = async (page: Page): Promise<string> => {
  const deviceId = await page.evaluate(() => localStorage.getItem('thunderbolt_device_id'))
  if (!deviceId) {
    throw new Error('Browser device ID was not initialized')
  }
  return deviceId
}

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

  const recoveryPhrase = await readRecoveryPhrase(dialog)

  await dialog.getByRole('checkbox').click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expect(syncSwitch).toBeChecked()
  return recoveryPhrase
}

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

export const finishAdditionalDeviceSetup = async (page: Page): Promise<void> => {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText("You're all set!", { exact: true })).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('switch', { name: 'Sync This Device With Cloud' })).toBeChecked()
}

export const readRecoveryPhrase = async (dialog: Locator): Promise<string> => {
  const recoveryRegion = dialog.getByRole('region', { name: 'Recovery phrase' })
  await expect(recoveryRegion).toBeVisible({ timeout: 30_000 })
  const recoveryPhrase = (await recoveryRegion.innerText()).trim()
  expect(recoveryPhrase.split(/\s+/)).toHaveLength(24)
  return recoveryPhrase
}

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

export const waitForTasksPreference = async (page: Page): Promise<void> => {
  await page.goto('/settings/preferences')
  await expect(page.getByRole('switch', { name: 'Tasks' })).toBeChecked({ timeout: 30_000 })
}

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

export const createTask = async (page: Page, taskText: string): Promise<void> => {
  await page.goto('/tasks')
  await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible()
  await page.getByRole('button', { name: 'New Task' }).click()
  const taskInput = page.getByPlaceholder('Add a new task...')
  await taskInput.fill(taskText)
  await taskInput.press('Enter')
  await expect(page.getByText(taskText, { exact: true })).toBeVisible()
}

export const signOutKeepingData = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('button', { name: 'Log out' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Log out' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByPlaceholder('Email')).toBeVisible({ timeout: 30_000 })
}

// =============================================================================
// v1 account seeding (data-preserving v1→v2 migration test)
// =============================================================================

/** v1 canary plaintext prefix — the absorbed CK decrypts it with NO AAD (D1 possession proof). */
const canaryPrefixV1 = 'thunderbolt-canary-v1'

const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Match v1 `generateCanarySecret`: 32 random bytes rendered lowercase hex (64 chars). */
const generateCanarySecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')

/** A single legacy content key + the operations needed to seed a v1 account around it. */
export type V1SeedCrypto = {
  /** AES-GCM(plaintext, CK) with NO AAD → `__enc:<iv>:<ct>` (v1 wire format). */
  encryptV1: (plaintext: string) => Promise<string>
  /** Hybrid-wrap the CK for one device's transport public keys (the legacy envelope payload). */
  wrapForDevice: (keys: DeviceKeys) => Promise<string>
  /** Build the CK-encrypted, no-AAD canary + its SHA-256 possession hash. */
  makeCanary: () => Promise<{ canaryIv: string; canaryCtext: string; canarySecretHash: string }>
}

/**
 * Create a fresh legacy content key (extractable AES-256-GCM) and the helpers to
 * build every v1 artifact from it. Extractable so `wrapForDevice` can AES-KW it
 * into the hybrid envelope — byte-identical to the v1/v2 envelope layout, which
 * is exactly what the migrator's `unwrapLegacyCK` expects.
 */
export const createV1SeedCrypto = async (): Promise<V1SeedCrypto> => {
  const ck = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])

  const encryptV1 = async (plaintext: string): Promise<string> => {
    const { iv, ciphertext } = await encrypt(plaintext, ck)
    return `__enc:${iv}:${ciphertext}`
  }

  const wrapForDevice = async (keys: DeviceKeys): Promise<string> => {
    const ecdhPublicKey = await importPublicKey(keys.publicKey)
    const mlkemPublicKey = importMlKemPublicKey(keys.mlkemPublicKey)
    return wrapAK(ck, ecdhPublicKey, mlkemPublicKey)
  }

  const makeCanary = async (): Promise<{ canaryIv: string; canaryCtext: string; canarySecretHash: string }> => {
    const canarySecret = generateCanarySecret()
    const { iv, ciphertext } = await encrypt(`${canaryPrefixV1}:${canarySecret}`, ck)
    return { canaryIv: iv, canaryCtext: ciphertext, canarySecretHash: await sha256Hex(canarySecret) }
  }

  return { encryptV1, wrapForDevice, makeCanary }
}

export type SeededV1Data = {
  taskId: string
  taskText: string
  settingKey: string
  settingValue: string
  threadId: string
  threadTitle: string
}

/**
 * Seed a complete, decryptable legacy v1 account server-side: a scheme-1 canary,
 * a hybrid envelope per trusted device (wrapping the SAME CK), the devices marked
 * trusted, and real v1-encrypted rows across representative tables (tasks,
 * settings, chat_threads). The returned plaintexts are asserted to reappear
 * after migration — proving zero data loss through the dual-read `"v1"` slot.
 */
export const seedV1Account = async (userId: string, deviceKeys: DeviceKeys[]): Promise<SeededV1Data> => {
  const seedCrypto = await createV1SeedCrypto()

  const canary = await seedCrypto.makeCanary()
  await seedV1Metadata(userId, canary)

  for (const keys of deviceKeys) {
    await seedV1Envelope(userId, keys.deviceId, await seedCrypto.wrapForDevice(keys))
    await trustDevice(keys.deviceId)
  }

  const data: SeededV1Data = {
    taskId: crypto.randomUUID(),
    taskText: `Legacy v1 task ${crypto.randomUUID()}`,
    settingKey: `legacy_pref_${crypto.randomUUID().slice(0, 8)}`,
    settingValue: `legacy-value-${crypto.randomUUID()}`,
    threadId: crypto.randomUUID(),
    threadTitle: `Legacy v1 thread ${crypto.randomUUID()}`,
  }

  await seedV1Task(userId, data.taskId, await seedCrypto.encryptV1(data.taskText))
  await seedV1Setting(userId, data.settingKey, await seedCrypto.encryptV1(data.settingValue))
  await seedV1ChatThread(userId, data.threadId, await seedCrypto.encryptV1(data.threadTitle))

  return data
}

// =============================================================================
// Migration wizard drivers
// =============================================================================

/**
 * Drive the sync-setup wizard just far enough to REGISTER this device (generate
 * its transport key pair in IndexedDB and POST its public keys), then dismiss it
 * WITHOUT setting up v2 encryption. Leaves the account at scheme "none" so the
 * subsequent v1 seed + `runSeamlessMigration` exercises the real upgrade path.
 */
export const registerDeviceOnly = async (page: Page): Promise<void> => {
  await page.goto('/settings/preferences')
  const syncSwitch = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
  await expect(syncSwitch).toBeVisible()
  await syncSwitch.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Set up sync', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  // `continueIntro` has now called `registerThisDevice`; a "none" account routes
  // to the first-device step. Dismiss without completing so no v2 keyring exists.
  await expect(dialog.getByText('First device setup', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(syncSwitch).not.toBeChecked()
}

/**
 * Drive the seamless v1→v2 migration through the sync-setup wizard: a v1 account
 * routes intro → detecting → `migrated` (NOT a reset), which reuses the
 * recovery-key display step to show the freshly minted 24-word phrase. Returns
 * the new phrase; sync is enabled on completion so legacy rows sync down.
 */
export const runSeamlessMigration = async (page: Page): Promise<string> => {
  await page.goto('/settings/preferences')
  const syncSwitch = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
  await expect(syncSwitch).toBeVisible()
  await syncSwitch.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Set up sync', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Continue' }).click()

  // Seamless migration lands directly on the recovery-phrase display (no separate
  // "First device setup" confirm, and never an "Encryption was upgraded" reset).
  const recoveryPhrase = await readRecoveryPhrase(dialog)
  await expect(dialog.getByText('Encryption was upgraded', { exact: true })).toBeHidden()

  await dialog.getByRole('checkbox').click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expect(syncSwitch).toBeChecked()
  return recoveryPhrase
}
