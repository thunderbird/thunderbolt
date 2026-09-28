/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import { remote } from 'webdriverio'
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

try {
  const email = await browser.$('input[placeholder="Email"]')
  await email.waitForDisplayed({ timeout: 60_000 })
  await email.setValue(`native-${crypto.randomUUID()}@thunderbolt.test`)
  await (await browser.$('//button[normalize-space()="Continue"]')).click()
  const otp = await browser.$('input[autocomplete="one-time-code"]')
  await otp.waitForDisplayed({ timeout: 30_000 })
  await otp.setValue('12345678')
  const composer = await browser.$('textarea')
  await composer.waitForDisplayed({ timeout: 60_000 })
  await (await browser.$('[data-testid="model-selector-trigger"]')).click()
  await (await browser.$('//button[normalize-space()="Opus 5"]')).click()
  await composer.setValue('Please greet me briefly.')
  await (await browser.$('button[aria-label="Send message"]')).click()
  await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes(fakeProviderReply), {
    timeout: 60_000,
    timeoutMsg: `The chat reply did not render: ${fakeProviderReply}`,
  })
  await browser.pause(1000) // Keep the complete reply visible in the recording.
  console.log('Linux desktop smoke passed')
} finally {
  await browser.deleteSession()
}
