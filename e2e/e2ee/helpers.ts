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
  getServerSetting,
  seedV1ChatThread,
  seedV1Envelope,
  seedV1Metadata,
  seedV1Setting,
  seedV1Task,
  trustDevice,
  waitForConsumedChallenge,
  waitForDeviceState,
  waitForOtp,
  type DeviceKeys,
} from './db'

export type DeviceProfile = 'firefox' | 'safari' | 'windows'

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

/**
 * How each profile's device renders in the devices list — the string
 * `revokeTrustedDevice` matches on. Derived from the user agents above by
 * `getDeviceDisplayName` (src/lib/platform.ts), so the two must stay in step.
 */
export const deviceLabels: Record<DeviceProfile, string> = {
  firefox: 'Firefox on macOS',
  safari: 'Safari on macOS',
  windows: 'Chrome on Windows',
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

/**
 * Bounded tail of each device's console output, so a failure can report what the
 * page was actually doing. Secondary devices are plain `browser.newContext()`
 * pages, which Playwright does not trace — without this, a device that fails to
 * sync leaves no evidence at all beyond a screenshot.
 *
 * The cap has to span EVERY boot of the device, not just the failing one: the
 * causes worth diagnosing (defaults seeded before first sync, a swallowed
 * pending-CRUD reset at sign-in) happen several page loads earlier than the
 * assertion that trips. A whole spec produces a few hundred lines per device.
 */
const consoleTails = new WeakMap<Page, string[]>()
const consoleTailLimit = 2_000

const recordConsole = (page: Page, profile: DeviceProfile): void => {
  const lines: string[] = []
  consoleTails.set(page, lines)
  // Set E2EE_DEBUG_CONSOLE=1 to stream it live instead of only on failure —
  // the only way to get a baseline from a run that PASSES, which is what you
  // need when a failure reproduces on CI but not locally.
  const stream = process.env.E2EE_DEBUG_CONSOLE === '1'
  page.on('console', (message) => {
    const line = `${message.type()}: ${message.text()}`
    if (stream) {
      console.log(`[${profile}] ${line}`)
    }
    lines.push(line)
    if (lines.length > consoleTailLimit) {
      lines.shift()
    }
  })
}

export const createIsolatedDevice = async (browser: Browser, profile: DeviceProfile): Promise<DeviceSession> => {
  const context = await browser.newContext({
    baseURL: 'http://localhost:1423',
    permissions: ['clipboard-read', 'clipboard-write'],
    userAgent: deviceUserAgents[profile],
  })
  const page = await context.newPage()
  recordConsole(page, profile)
  return { context, page }
}

export const getDeviceId = async (page: Page): Promise<string> => {
  const deviceId = await page.evaluate(() => localStorage.getItem('thunderbolt_device_id'))
  if (!deviceId) {
    throw new Error('Browser device ID was not initialized')
  }
  return deviceId
}

/** Backend origin the frontend bundle points at (VITE_THUNDERBOLT_CLOUD_URL). */
const backendBaseUrl = 'http://localhost:8004/v1'

export type EncryptionApiResponse = { status: number; body: unknown }

/**
 * Replay a page's retained bearer token against the backend with an
 * attacker-chosen `X-Device-ID`. Runs the fetch inside the page so it carries
 * exactly the credential that context still holds — the A4 primitive for probing
 * whether a revoked device's cached token is actually refused, and whether the
 * caller-asserted device id buys anything. Omit `deviceId` to send no header.
 */
export const encryptionApiRequest = async (
  page: Page,
  path: string,
  options: { method?: string; deviceId?: string; body?: unknown } = {},
): Promise<EncryptionApiResponse> =>
  page.evaluate(
    async ({ url, method, deviceId, body }) => {
      const headers: Record<string, string> = {}
      const token = localStorage.getItem('thunderbolt_auth_token')
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }
      if (deviceId) {
        headers['X-Device-ID'] = deviceId
      }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
      }
      const response = await fetch(url, {
        method: method ?? 'GET',
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const parsed = await response.json().catch(() => null)
      return { status: response.status, body: parsed }
    },
    { url: `${backendBaseUrl}${path}`, method: options.method, deviceId: options.deviceId, body: options.body },
  )

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

/**
 * Whichever dialog is currently showing a recovery phrase — the setup wizard's
 * own step or the global migration dialog. Identified by the phrase region
 * rather than by title, so it resolves to exactly one node even while a yielding
 * wizard is still animating out alongside the migration dialog.
 */
export const recoveryPhraseDialog = (page: Page): Locator =>
  page.getByRole('dialog').filter({ has: page.getByRole('region', { name: 'Recovery phrase' }) })

/**
 * Read the phrase, confirm it was saved, and dismiss.
 *
 * Confirming is not cosmetic: it clears the pending flag that every mint sets.
 * Skip it and the account is left owing a phrase, so `UnsavedRecoveryPhrasePrompt`
 * blocks the whole UI on the next boot — correctly, which is why a test that
 * mints a phrase has to acknowledge it like a user would.
 */
export const acknowledgeRecoveryPhrase = async (dialog: Locator): Promise<string> => {
  const recoveryPhrase = await readRecoveryPhrase(dialog)
  await dialog.getByRole('checkbox').click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  return recoveryPhrase
}

/**
 * Revoke a trusted device from the devices settings page.
 *
 * Revocation still rotates the Account Key — that is the only step that
 * cryptographically locks the revoked device out — but the recovery phrase is a
 * virtual device now, so the rotation re-anchors the EXISTING recovery slot
 * instead of minting a new phrase. The flow is therefore silent, and the confirm
 * copy must not promise a new phrase; `expectNoRecoveryPhraseShown` checks the
 * other half once the rotation has landed server-side.
 */
export const revokeTrustedDevice = async (page: Page, deviceLabel: string): Promise<void> => {
  await page.goto('/settings/devices')
  await page.getByRole('button', { name: `Revoke ${deviceLabel}` }).click()
  const revokeDialog = page.getByRole('alertdialog')
  await expect(revokeDialog.getByText('Revoke this device?')).toBeVisible()
  await expect(revokeDialog.getByText(/new recovery phrase/i)).toBeHidden()
  await revokeDialog.getByRole('button', { name: 'Revoke' }).click()
  await expect(revokeDialog).toBeHidden({ timeout: 30_000 })
}

/**
 * Assert nothing on screen is offering the user a phrase to write down.
 *
 * Only meaningful AFTER the rotation is observable server-side: the phrase
 * dialog would open from the mutation's success callback, so asserting earlier
 * would pass vacuously against a dialog that has simply not rendered yet.
 */
export const expectNoRecoveryPhraseShown = async (page: Page): Promise<void> => {
  await expect(recoveryPhraseDialog(page)).toBeHidden()
  await expect(page.getByRole('dialog').filter({ hasText: 'Save your new recovery phrase' })).toBeHidden()
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

export const waitForTasksPreference = async (page: Page, userId: string): Promise<void> => {
  await page.goto('/settings/preferences')
  // The Tasks preference is an encrypted setting that must sync down to this
  // device and decrypt before the switch reflects checked — allow generous
  // headroom for PowerSync propagation on a loaded CI runner.
  try {
    await expect(page.getByRole('switch', { name: 'Tasks' })).toBeChecked({ timeout: 120_000 })
  } catch (error) {
    throw new Error(await describeTasksPreferenceFailure(page, userId), { cause: error })
  }
}

/**
 * Explain WHY the Tasks switch never flipped. The states look identical in the
 * UI but have completely different causes:
 *
 *  - server value decrypts to `false` → something overwrote the account's
 *    setting. Read it off the ciphertext length: base64 ct of 28 chars is 21
 *    bytes, minus the 16-byte GCM tag, so a 5-byte plaintext (`false`); `true`
 *    is 4 bytes and encodes to 27 (or 28 WITH an `=`).
 *  - server value encrypted but this device holds no `thunderbolt_dek_*` → the
 *    keyring never landed, so the codec stored ciphertext as the value;
 *  - server value encrypted and the keyring is complete → a download/decode
 *    problem, and the console should show the codec or key-request failing.
 *
 * The console is dumped in FULL rather than tailed: the interesting lines
 * ("Uploading N operations to backend" as a joining device flushes bundle
 * defaults over the account, or "Failed to clear pending CRUD after sign-in"
 * when the reset that normally hides that is skipped) come from boots well
 * before the failing one.
 */
const describeTasksPreferenceFailure = async (page: Page, userId: string): Promise<string> => {
  const [serverValue, keyNames] = await Promise.all([
    getServerSetting(userId, 'experimental_feature_tasks').catch((err: unknown) => `<unreadable: ${String(err)}>`),
    getEncryptionKeyNames(page).catch((err: unknown) => [`<unreadable: ${String(err)}>`]),
  ])
  const tail = consoleTails.get(page) ?? []
  return [
    'Tasks preference never synced/decrypted on this device.',
    `  server experimental_feature_tasks: ${serverValue ?? '<row missing>'}`,
    `  device IndexedDB keys: ${keyNames.join(', ') || '<none>'}`,
    `  device console (${tail.length} lines${tail.length >= consoleTailLimit ? ', TRUNCATED at the cap' : ''}):`,
    ...tail.map((line) => `    ${line}`),
  ].join('\n')
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

/**
 * Edit an existing task's text in place: click its text (which becomes an input),
 * replace the value, and save with Enter. Gives a cell a second valid ciphertext
 * so a rollback attack has an older version to replay.
 */
export const editTask = async (page: Page, currentText: string, newText: string): Promise<void> => {
  await page.getByRole('button', { name: currentText, exact: true }).click()
  const input = page.locator('input:focus')
  await input.fill(newText)
  await input.press('Enter')
  await expect(page.getByText(newText, { exact: true })).toBeVisible()
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
 * Turn sync on for a device that already holds the keyring, so no wizard opens
 * (`needsSyncSetupWizard` is false once an AK and at least one DEK are staged).
 *
 * Needed after a HEADLESS migration: `runEncryptionInit` provisions keys, but it
 * deliberately does not opt the device into syncing — that stays the user's
 * choice, expressed through this toggle.
 */
export const enableSyncWithoutWizard = async (page: Page): Promise<void> => {
  await page.goto('/settings/preferences')
  const syncSwitch = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
  await expect(syncSwitch).toBeVisible()
  if (await syncSwitch.isChecked()) {
    return
  }
  await syncSwitch.click()
  await expect(syncSwitch).toBeChecked()
}

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
 * Drive the seamless v1→v2 migration and return the freshly minted 24-word
 * phrase. Sync is enabled on completion so legacy rows sync down.
 *
 * TWO surfaces can legitimately show the phrase, because two code paths race to
 * call `ensureV2Encryption`:
 *
 *  - the sync-setup wizard, when the user's Continue lands first, and
 *  - the global migration dialog, when `runEncryptionInit`'s headless check
 *    (fire-and-forget at every boot) gets there first — at which point the
 *    wizard yields and completes itself.
 *
 * Init usually wins: it starts during boot, while the wizard cannot start before
 * the user reaches the switch. So Continue is best-effort, and the phrase is read
 * from whichever dialog ends up holding it. Both outcomes are the same product
 * behaviour — one phrase, shown once, sync on — and the spec asserts the
 * "migrated, not reset" invariant against the server keyring rather than the UI.
 */
export const runSeamlessMigration = async (page: Page): Promise<string> => {
  await page.goto('/settings/preferences')
  const syncSwitch = page.getByRole('switch', { name: 'Sync This Device With Cloud' })
  await expect(syncSwitch).toBeVisible()
  await syncSwitch.click()

  const wizard = page.getByRole('dialog')
  await expect(wizard.getByText('Set up sync', { exact: true })).toBeVisible()
  await wizard
    .getByRole('button', { name: 'Continue' })
    .click({ timeout: 15_000 })
    // The wizard can be torn down mid-click when init wins the race.
    .catch(() => {})

  const phraseDialog = recoveryPhraseDialog(page)
  await expect(phraseDialog).toBeVisible({ timeout: 30_000 })
  // A seamless upgrade never routes through first-device bootstrap — that step
  // is the reset path, which would abandon the legacy CK instead of absorbing it.
  await expect(page.getByText('First device setup', { exact: true })).toBeHidden()

  const recoveryPhrase = await acknowledgeRecoveryPhrase(phraseDialog)
  await expect(syncSwitch).toBeChecked()
  return recoveryPhrase
}

// =============================================================================
// Adversary contexts
// =============================================================================

/**
 * Approve the pending-device prompt on an already-trusted device. Two dialogs:
 * the notification, then a confirmation. Extracted from multi-device.spec.ts so
 * attack specs can reach full trust without restating the sequence.
 */
export const approvePendingDevice = async (adminPage: Page): Promise<void> => {
  const notification = adminPage.getByRole('dialog').filter({ hasText: 'New device waiting' })
  await expect(notification).toBeVisible({ timeout: 30_000 })
  await notification.getByRole('button', { name: 'Approve' }).click()
  const confirmation = adminPage.getByRole('alertdialog')
  await expect(confirmation.getByText('Approve this device?')).toBeVisible()
  await confirmation.getByRole('button', { name: 'Approve' }).click()
}

export type TrustedDevice = DeviceSession & {
  deviceId: string
  label: string
}

export type AdditionalDeviceOptions = {
  email: string
  userId: string
  profile: DeviceProfile
}

/**
 * Bring a second device all the way to trust: register, wait for pending,
 * approve from `adminPage`, then finish setup. Returns the still-open session,
 * so a caller can keep acting as that device afterwards.
 */
export const trustAdditionalDevice = async (
  browser: Browser,
  adminPage: Page,
  { email, userId, profile }: AdditionalDeviceOptions,
): Promise<TrustedDevice> => {
  const device = await createIsolatedDevice(browser, profile)
  await loginViaConsumerOtp(device.page, email)
  await startAdditionalDeviceSetup(device.page)
  const deviceId = await getDeviceId(device.page)
  await waitForDeviceState(userId, deviceId, (state) => state.approvalPending && !state.trusted)

  await approvePendingDevice(adminPage)
  await waitForConsumedChallenge(userId, 'approve')
  await waitForDeviceState(userId, deviceId, (state) => state.trusted && state.hasEnvelope)
  await finishAdditionalDeviceSetup(device.page)

  return { ...device, deviceId, label: deviceLabels[profile] }
}

/**
 * A4 — a device that held full trust and was then revoked, with its browser
 * context left open so it keeps whatever key material it cached.
 *
 * That retention is the point: revocation deletes the server envelope and
 * rotates AK and DEK, but it cannot reach into this context's IndexedDB. What
 * the device can still *do* with what it kept is claim C5.
 */
export const revokedDeviceContext = async (
  browser: Browser,
  adminPage: Page,
  options: AdditionalDeviceOptions,
): Promise<TrustedDevice> => {
  const device = await trustAdditionalDevice(browser, adminPage, options)
  await revokeTrustedDevice(adminPage, device.label)
  await waitForConsumedChallenge(options.userId, 'revoke')
  await waitForDeviceState(options.userId, device.deviceId, (state) => state.revokedAt !== null)
  return device
}

/**
 * A5 — a valid authenticated session holding no key material: signed in, never
 * set up for sync, so no AK, no DEK, no device envelope. Models a stolen token
 * rather than a stolen device.
 */
export const stolenSessionContext = async (
  browser: Browser,
  email: string,
  profile: DeviceProfile = 'safari',
): Promise<DeviceSession> => {
  const device = await createIsolatedDevice(browser, profile)
  await loginViaConsumerOtp(device.page, email)
  return device
}

/**
 * A2/A8 — answer `GET /v1/encryption/org-key` with a key the attacker controls.
 *
 * The client fetches the escrow public key from the very server the design
 * distrusts, so this is the whole of claim C11: if nothing pins or verifies that
 * key out of band, every AK this context writes is wrapped to the attacker.
 * Routed on the context so it covers every page in it.
 */
export const serveEvilOrgKey = async (
  context: BrowserContext,
  key: { publicKey: string; fingerprint: string },
): Promise<void> => {
  await context.route('**/v1/encryption/org-key', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, publicKey: key.publicKey, fingerprint: key.fingerprint }),
    })
  })
}

/**
 * A2/A10 — lie about `scheme_version` in the encryption-metadata response,
 * preserving every other field. Models a malicious server trying to steer a
 * client's scheme decision (e.g. flip a set-up v2 device back to `1` to provoke
 * a re-migration / v1 downgrade). Fetches the real response first so only the
 * one field changes.
 */
export const forceSchemeVersion = async (context: BrowserContext, version: number): Promise<void> =>
  overrideEncryptionMetadata(context, { scheme_version: version })

/**
 * A2 — merge arbitrary fields into the encryption-metadata response
 * (`GET /encryption/canary`), preserving everything else. The general form of
 * `forceSchemeVersion`: models a server lying about any server-controlled
 * metadata input (`kdf_salt`, `recovery_*`, `key_version`, …) to probe whether
 * the client fails cleanly rather than downgrading or leaking.
 */
export const overrideEncryptionMetadata = async (
  context: BrowserContext,
  overrides: Record<string, unknown>,
): Promise<void> => {
  await context.route('**/v1/encryption/canary', async (route) => {
    const response = await route.fetch()
    if (!response.ok()) {
      await route.fulfill({ response })
      return
    }
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...body, ...overrides } })
  })
}
