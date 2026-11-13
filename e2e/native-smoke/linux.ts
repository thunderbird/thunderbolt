/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { Key, remote } from 'webdriverio'
import { z } from 'zod'
import { fakeOpenAiModelId, fakeProviderReply } from '../fake-provider'

// linux.sh runs this once per setup choice, each from a fresh install.
const setup = z.enum(['local', 'cloud']).parse(process.argv[2])
const providerUrl = process.env.PROVIDER_URL ?? 'http://127.0.0.1:9878/v1'

const capabilities = {
  browserName: 'wry',
  'wdio:enforceWebDriverClassic': true,
  'tauri:options': { application: resolve('src-tauri/target/debug/thunderbolt') },
}

const browser = await remote({
  hostname: '127.0.0.1',
  port: 4444,
  logLevel: 'warn',
  capabilities,
})

/** What the native commands this smoke calls take and return: a tray id, a visibility flag, or nothing. */
const nativeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
type NativeValue = z.infer<typeof nativeValueSchema>

/** Exercise native commands through the desktop webview's public Tauri bridge. */
const invokeNative = async (command: string, args: Record<string, NativeValue> = {}): Promise<NativeValue> =>
  nativeValueSchema.parse(
    await browser.execute('return window.__TAURI__.core.invoke(arguments[0], arguments[1])', command, args),
  )

/** Wait for a wizard step by its heading. The chat behind the wizard has its own "Connect your AI" heading. */
const waitForStep = async (heading: string) =>
  (await browser.$(`//*[@role="dialog"]//h2[contains(normalize-space(), "${heading}")]`)).waitForDisplayed({
    timeout: 60_000,
  })

/** Find a button by its exact text and click it once it can be clicked. */
const clickButton = async (text: string) => {
  const button = await browser.$(`//button[normalize-space()="${text}"]`)
  await button.waitForClickable({ timeout: 30_000 })
  await button.click()
}

/** Local: no server and no account; the user connects their own OpenAI-compatible model. */
const setUpLocal = async () => {
  await (await browser.$('input[aria-label="Local"]')).click()
  await clickButton('Continue')
  await waitForStep('Connect your AI')
  await (await browser.$('input[aria-label="Other provider"]')).click()
  await clickButton('Continue')
  await waitForStep('Add a model')
  await (await browser.$('input[placeholder="http://localhost:11434/v1"]')).setValue(providerUrl)
  // The model list loads from the provider when the picker opens.
  await (await browser.$('//button[@role="combobox"][contains(., "Select model")]')).click()
  const model = await browser.$(`//*[@role="option"][normalize-space()="${fakeOpenAiModelId}"]`)
  await model.waitForDisplayed({ timeout: 30_000 })
  await model.click()
  await clickButton('Test model')
  await (await browser.$('//*[contains(text(), "Test successful!")]')).waitForDisplayed({ timeout: 30_000 })
  await clickButton('Add Model')
  await waitForStep('Add web search')
  await clickButton('Skip')
}

/** Cloud: a waitlist account on the smoke backend, signed in with its fixed code. */
const setUpCloud = async () => {
  await (await browser.$('input[aria-label="Cloud (Waitlist)"]')).click()
  await clickButton('Continue')
  const email = await browser.$('input[placeholder="Email"]')
  await email.waitForDisplayed({ timeout: 60_000 })
  await email.setValue(`native-${crypto.randomUUID()}@thunderbolt.test`)
  await clickButton('Continue')
  const otp = await browser.$('input[autocomplete="one-time-code"]')
  await otp.waitForDisplayed({ timeout: 30_000 })
  await otp.setValue('12345678')
  await waitForStep('Connect Google')
  await clickButton('Skip')
}

try {
  // A fresh install opens the setup wizard. Reload it here: under tauri-driver a reload drops the app's
  // data and brings back a fresh install, so a reload after setup would undo it.
  await (await browser.$('#terms-agreement')).waitForDisplayed({ timeout: 60_000 })
  const trayBeforeReload = await invokeNative('plugin:tray|get_by_id', { id: 'main-tray' })
  assert.ok(Number.isInteger(trayBeforeReload), 'The desktop tray should be initialized')
  await Promise.all([
    invokeNative('initialize_tray', { showLabel: 'Show', quitLabel: 'Quit' }),
    invokeNative('initialize_tray', { showLabel: 'Show', quitLabel: 'Quit' }),
  ])
  await browser.refresh()
  const terms = await browser.$('#terms-agreement')
  await terms.waitForDisplayed({ timeout: 60_000 })
  assert.equal(
    await invokeNative('plugin:tray|get_by_id', { id: 'main-tray' }),
    trayBeforeReload,
    'Reloading the frontend should retain the native tray',
  )

  // Accept the terms, then choose how to use the app.
  await terms.click()
  await clickButton('Continue')
  await waitForStep('Choose your setup')
  await (setup === 'local' ? setUpLocal() : setUpCloud())
  await waitForStep('What should we call you?')
  await (await browser.$('input[placeholder="Enter your name"]')).setValue('Smoke')
  await clickButton('Continue')
  if (setup === 'cloud') {
    // The location picker opens on its own; close it before skipping the step.
    await waitForStep('Where are you located?')
    await browser.keys(Key.Escape)
    await clickButton('Skip')
  }
  await waitForStep('Which language do you prefer?')
  await clickButton('Continue')
  await waitForStep("You're all set!")
  await clickButton('Continue')
  const composer = await browser.$('textarea')
  await composer.waitForDisplayed({ timeout: 60_000 })
  const appReadyAt = Date.now()
  assert.equal(
    await (await browser.$('section[aria-label="Security notice"]')).isExisting(),
    false,
    'A new account must not show the recovery banner',
  )

  await invokeNative('plugin:window|close', { label: 'main' })
  await browser.waitUntil(async () => (await invokeNative('plugin:window|is_visible', { label: 'main' })) === false)
  await invokeNative('show_main_window')
  await browser.waitUntil(async () => (await invokeNative('plugin:window|is_visible', { label: 'main' })) === true)

  if (setup === 'local') {
    // The model added during setup is already the chat's model. Wait for it: the window has just come back.
    await (
      await browser.$('//*[@data-testid="model-selector-trigger"][contains(., "Fake Model")]')
    ).waitForDisplayed({ timeout: 30_000 })
  } else {
    // The backend routes Anthropic models to the fake provider; the default model is not faked.
    await (await browser.$('[data-testid="model-selector-trigger"]')).click()
    const standardModel = await browser.$('//button[normalize-space()="Opus 5.5"]')
    await (await standardModel.$('[role="img"][aria-label="Thunderbolt"]')).waitForDisplayed()
    await standardModel.click()
    await browser.keys(Key.Escape)
  }
  const previewUrl = 'https://example.invalid/native-preview-check'
  await composer.setValue(`Please greet me briefly. [Preview safety check](${previewUrl})`)
  await (await browser.$('button[aria-label="Send message"]')).click()
  await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes(fakeProviderReply), {
    timeout: 60_000,
    timeoutMsg: `The chat reply did not render: ${fakeProviderReply}`,
  })
  await browser.pause(1000) // Keep the complete reply visible in the recording.
  await browser.waitUntil(() => Date.now() - appReadyAt >= 6000, { timeout: 10_000 })
  assert.equal((await (await browser.$('body')).getText()).includes('Update failed'), false)

  // Linux must never put an external page in a native sidebar webview (THU-1042).
  await (await browser.$(`a[href="${previewUrl}"]`)).click()
  const linkDialog = await browser.$('[role="alertdialog"]')
  await linkDialog.waitForDisplayed({ timeout: 10_000 })
  assert.equal(
    await (await linkDialog.$('//button[normalize-space()="Open in Sidebar"]')).isExisting(),
    false,
    'Linux link confirmation must not offer a native sidebar',
  )
  assert.ok(
    await (await linkDialog.$('//button[normalize-space()="Open Link"]')).isDisplayed(),
    'Linux link confirmation must offer external opening',
  )
  await (await linkDialog.$('//button[normalize-space()="Cancel"]')).click()
  await browser.url(new URL('/settings/preferences', await browser.getUrl()).href)
  const ask = await browser.$('[role="radio"][aria-label="Always ask"]')
  await ask.waitForDisplayed({ timeout: 30_000 })
  assert.equal(
    await (await browser.$('[role="radio"][aria-label="Open in sidebar"]')).isExisting(),
    false,
    'Linux must not offer external sidebar webviews',
  )
  const openInBrowser = await browser.$('[role="radio"][aria-label="Open in browser"]')
  await openInBrowser.click()
  assert.equal(await openInBrowser.getAttribute('data-state'), 'on', 'The Linux browser preference was not selected')
  await ask.click()
  // eslint-disable-next-line no-console -- Report successful completion in the smoke-test runner output.
  console.log(`Linux desktop smoke passed (${setup})`)
} finally {
  await browser.deleteSession()
}
