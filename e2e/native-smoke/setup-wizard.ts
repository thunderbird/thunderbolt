/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Key } from 'webdriverio'
import { fakeOpenAiModelId } from '../fake-provider'

type Browser = WebdriverIO.Browser

const providerUrl = process.env.PROVIDER_URL ?? 'http://127.0.0.1:9878/v1'

/** Wait for a wizard step by its heading. The chat behind the wizard has its own "Connect your AI" heading. */
const waitForStep = async (browser: Browser, heading: string) =>
  (await browser.$(`//*[@role="dialog"]//h2[contains(normalize-space(), "${heading}")]`)).waitForDisplayed({
    timeout: 60_000,
  })

/** Find a button by its exact text and click it once it can be clicked. */
export const clickButton = async (browser: Browser, text: string) => {
  const button = await browser.$(`//button[normalize-space()="${text}"]`)
  await button.waitForClickable({ timeout: 30_000 })
  await button.click()
}

/** Local: no server and no account; the user connects their own OpenAI-compatible model. */
const setUpLocal = async (browser: Browser) => {
  await (await browser.$('input[aria-label="Local"]')).click()
  await clickButton(browser, 'Continue')
  await waitForStep(browser, 'Connect your AI')
  await (await browser.$('input[aria-label="Other provider"]')).click()
  await clickButton(browser, 'Continue')
  await waitForStep(browser, 'Add a model')
  await (await browser.$('input[placeholder="http://localhost:11434/v1"]')).setValue(providerUrl)
  // The model list loads from the provider when the picker opens.
  await (await browser.$('//button[@role="combobox"][contains(., "Select model")]')).click()
  const model = await browser.$(`//*[@role="option"][normalize-space()="${fakeOpenAiModelId}"]`)
  await model.waitForDisplayed({ timeout: 30_000 })
  await model.click()
  await clickButton(browser, 'Test model')
  await (await browser.$('//*[contains(text(), "Test successful!")]')).waitForDisplayed({ timeout: 30_000 })
  await clickButton(browser, 'Add Model')
  await waitForStep(browser, 'Add web search')
  await clickButton(browser, 'Skip')
}

/** Cloud: a waitlist account on the smoke backend, signed in with its fixed code. */
const setUpCloud = async (browser: Browser) => {
  await (await browser.$('input[aria-label="Cloud (Waitlist)"]')).click()
  await clickButton(browser, 'Continue')
  const email = await browser.$('input[placeholder="Email"]')
  await email.waitForDisplayed({ timeout: 60_000 })
  await email.setValue(`native-${crypto.randomUUID()}@thunderbolt.test`)
  await clickButton(browser, 'Continue')
  const otp = await browser.$('input[autocomplete="one-time-code"]')
  await otp.waitForDisplayed({ timeout: 30_000 })
  await otp.setValue('12345678')
  await waitForStep(browser, 'Connect Google')
  await clickButton(browser, 'Skip')
}

/**
 * Takes a fresh install's setup wizard from the terms to the chat. Local connects the fake provider at
 * `PROVIDER_URL`; cloud signs up on the backend of `services.sh`, which the build must name in
 * `VITE_THUNDERBOLT_CLOUD_SERVICE_URL`.
 */
export const completeSetup = async (browser: Browser, setup: 'local' | 'cloud') => {
  // Accept the terms, then choose how to use the app.
  const terms = await browser.$('#terms-agreement')
  await terms.waitForDisplayed({ timeout: 60_000 })
  await terms.click()
  await clickButton(browser, 'Continue')
  await waitForStep(browser, 'Choose your setup')
  await (setup === 'local' ? setUpLocal(browser) : setUpCloud(browser))
  await waitForStep(browser, 'What should we call you?')
  await (await browser.$('input[placeholder="Enter your name"]')).setValue('Smoke')
  await clickButton(browser, 'Continue')
  if (setup === 'cloud') {
    // The location picker opens on its own; close it before skipping the step.
    await waitForStep(browser, 'Where are you located?')
    await browser.keys(Key.Escape)
    await clickButton(browser, 'Skip')
  }
  await waitForStep(browser, 'Which language do you prefer?')
  await clickButton(browser, 'Continue')
  await waitForStep(browser, "You're all set!")
  await clickButton(browser, 'Continue')
  await (await browser.$('textarea')).waitForDisplayed({ timeout: 60_000 })
}
