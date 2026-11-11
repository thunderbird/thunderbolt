/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { Key, remote } from 'webdriverio'
import { fakeProviderReply } from '../fake-provider'

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

/** Exercise native commands through the desktop webview's public Tauri bridge. */
const invokeNative = (command: string, args: Record<string, unknown> = {}) =>
  browser.execute(
    (command, args) => {
      const native = window as unknown as {
        __TAURI__: { core: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> } }
      }
      return native.__TAURI__.core.invoke(command, args)
    },
    command,
    args,
  )

try {
  const signIn = await browser.$('button[aria-label="Sign in"]')
  await signIn.waitForDisplayed({ timeout: 60_000 })
  await signIn.click()
  await (await browser.$('input[aria-label="Cloud (Waitlist)"]')).click()
  await (await browser.$('//button[normalize-space()="Continue"]')).click()
  const email = await browser.$('input[placeholder="Email"]')
  await email.waitForDisplayed({ timeout: 60_000 })
  await email.setValue(`native-${crypto.randomUUID()}@thunderbolt.test`)
  await (await browser.$('//button[normalize-space()="Continue"]')).click()
  const otp = await browser.$('input[autocomplete="one-time-code"]')
  await otp.waitForDisplayed({ timeout: 30_000 })
  await otp.setValue('12345678')
  const syncSetup = await browser.$('//div[@role="dialog"][.//h2[normalize-space()="Set up sync"]]')
  await syncSetup.waitForDisplayed({ timeout: 60_000 })
  await (await syncSetup.$('.//button[normalize-space()="Close"]')).click()
  await (await browser.$('textarea')).waitForDisplayed({ timeout: 60_000 })

  const trayBeforeReload = await invokeNative('plugin:tray|get_by_id', { id: 'main-tray' })
  assert.equal(typeof trayBeforeReload, 'number', 'The desktop tray should be initialized')
  await Promise.all([
    invokeNative('initialize_tray', { showLabel: 'Show', quitLabel: 'Quit' }),
    invokeNative('initialize_tray', { showLabel: 'Show', quitLabel: 'Quit' }),
  ])
  await browser.refresh()
  const composer = await browser.$('textarea')
  await composer.waitForDisplayed({ timeout: 60_000 })
  const appReadyAt = Date.now()
  assert.equal(
    await invokeNative('plugin:tray|get_by_id', { id: 'main-tray' }),
    trayBeforeReload,
    'Reloading the frontend should retain the native tray',
  )

  await invokeNative('plugin:window|close', { label: 'main' })
  await browser.waitUntil(async () => (await invokeNative('plugin:window|is_visible', { label: 'main' })) === false)
  await invokeNative('show_main_window')
  await browser.waitUntil(async () => (await invokeNative('plugin:window|is_visible', { label: 'main' })) === true)

  await (await browser.$('[data-testid="model-selector-trigger"]')).click()
  await (await browser.$('//button[normalize-space()="Opus 5.5"]')).click()
  await browser.keys(Key.Escape)
  await composer.setValue('Please greet me briefly.')
  await (await browser.$('button[aria-label="Send message"]')).click()
  await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes(fakeProviderReply), {
    timeout: 60_000,
    timeoutMsg: `The chat reply did not render: ${fakeProviderReply}`,
  })
  await browser.pause(1000) // Keep the complete reply visible in the recording.
  await browser.waitUntil(() => Date.now() - appReadyAt >= 6000, { timeout: 10_000 })
  assert.equal((await (await browser.$('body')).getText()).includes('Update failed'), false)
  // eslint-disable-next-line no-console -- Report successful completion in the smoke-test runner output.
  console.log('Linux desktop smoke passed')
} finally {
  await browser.deleteSession()
}
