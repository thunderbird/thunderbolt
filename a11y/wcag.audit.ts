/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { addNote, inAppOrOnboarding, notesPath, signedInPage } from './support/auth'
import {
  checkDuplicateNames,
  checkFocusReturn,
  checkKeyboardFocus,
  checkReflow,
  resultsPath,
  scanAxe,
} from './support/checks'

test.beforeAll(() => {
  rmSync(resultsPath, { force: true })
  rmSync(notesPath, { force: true })
})

/** axe in light and dark, plus the keyboard, reflow and naming checks. */
const auditScreen = async (page: Page, state: string, options: { reflow?: boolean; keyboard?: boolean } = {}) => {
  await scanAxe(page, `${state} (light)`)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await scanAxe(page, `${state} (dark)`)
  await page.emulateMedia({ colorScheme: 'light' })
  await checkDuplicateNames(page, state)
  if (options.keyboard !== false) {
    await checkKeyboardFocus(page, state)
  }
  if (options.reflow !== false) {
    await checkReflow(page, state, 640)
    await checkReflow(page, state, 320)
  }
}

/** Send a prompt and wait for the answer to finish streaming. */
const ask = async (page: Page, prompt: string) => {
  const copyButtons = page.getByRole('button', { name: /^Copy message/ })
  const before = await copyButtons.count()
  await page.getByPlaceholder('Ask me anything…').fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await test.expect(copyButtons).toHaveCount(before + 1, { timeout: 180_000 })
  // The copy button appears while the turn is still streaming; wait for it to really end.
  await test.expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, { timeout: 120_000 })
  await test.expect(copyButtons.last()).toBeVisible()
}

const settingsScreens = [
  ['Settings: Preferences', '/settings/preferences'],
  ['Settings: Models', '/settings/models'],
  ['Settings: Connections', '/settings/connections'],
  ['Settings: Skills', '/settings/skills'],
  ['Settings: Devices', '/settings/devices'],
] as const

test('signed-out entry screen', async ({ page }) => {
  await page.goto('/')
  // Depending on the target, the first screen is a Keycloak page, the email step, or (anonymous
  // deployments such as production) the chat behind the onboarding wizard. Loading an anonymous
  // deployment makes the app create an anonymous user there, but nothing is written beyond that.
  const entry = page.locator('#username, input[placeholder="Email"]').or(inAppOrOnboarding(page))
  await entry.first().waitFor({ timeout: 90_000 })
  await auditScreen(page, 'Signed-out entry')
})

test('signed in: chat and settings', async ({ browser }) => {
  const page = await signedInPage(browser)
  test.skip(!page, 'signed-in screens unreachable for this target, see the report coverage note')
  if (!page) {
    return
  }

  await auditScreen(page, 'Chat home')
  // The account menu only exists for a signed-in account; anonymous deployments don't show it.
  const accountMenu = page.getByRole('button', { name: 'Account menu' })
  if (await accountMenu.isVisible()) {
    await checkFocusReturn(page, 'Chat home', accountMenu, 'the account menu')
  }
  await checkFocusReturn(page, 'Chat home', page.getByRole('button', { name: 'Search' }).first(), 'the search palette')

  for (const [state, path] of settingsScreens) {
    await page.goto(path)
    await page.getByRole('heading').first().waitFor()
    await auditScreen(page, state)
  }

  if (process.env.A11Y_PROMPTS === '1') {
    await page.goto('/')
    await ask(page, 'What is the capital of France, and why did it become the capital?')
    await auditScreen(page, 'Chat answer')
  } else {
    addNote('Chat answer screen was not audited: set A11Y_PROMPTS=1 to send a real prompt (needs a working model).')
  }
})
