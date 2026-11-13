/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, type Page } from '@playwright/test'
import { addNote, inAppOrOnboarding, markScreen, signedInPage } from './support/auth'
import { checkDuplicateNames, checkFocusReturn, checkKeyboardFocus, checkReflow, scanAxe } from './support/checks'
import { canSetTheme, setAppTheme } from './support/theme'

/** Waits until a screen has finished rendering. Run after every theme reload, before scanning. */
type Ready = () => Promise<unknown>

/**
 * axe under each app theme, plus the keyboard, reflow and naming checks (run in light). The theme
 * setting is read at startup, so each switch reloads the page. `index.html` sets the root theme class before
 * React mounts, so `ready` must confirm the screen itself is back; scanning a spinner would record a clean
 * result. If it never is, the screen is left unfinished and the report says Incomplete.
 */
const auditScreen = async (
  page: Page,
  state: string,
  ready: Ready,
  options: { reflow?: boolean; keyboard?: boolean } = {},
) => {
  markScreen('started', state)
  try {
    await ready()
    if (canSetTheme(page)) {
      await setAppTheme(page, 'dark')
      await ready()
      await scanAxe(page, `${state} (dark)`)
      await setAppTheme(page, 'light')
      await ready()
      await scanAxe(page, `${state} (light)`)
    } else {
      await scanAxe(page, `${state} (default theme)`)
    }
  } catch (error) {
    addNote(`${state} was not scanned because the screen never finished loading: ${String(error).split('\n')[0]}`)
    return
  }
  await checkDuplicateNames(page, state)
  if (options.keyboard !== false) {
    await checkKeyboardFocus(page, state)
  }
  if (options.reflow !== false) {
    await checkReflow(page, state, 640)
    await checkReflow(page, state, 320)
  }
  markScreen('completed', state)
}

/** Only the assistant's message root carries `data-quotable-message-id`; user messages also have a copy button. */
const assistantCopyButtons = (page: Page) =>
  page.locator('[data-quotable-message-id]').getByRole('button', { name: /^Copy message/ })

/** Send a prompt and wait for the answer to finish streaming. */
const ask = async (page: Page, prompt: string) => {
  const copyButtons = assistantCopyButtons(page)
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
  await auditScreen(page, 'Signed-out entry', () => entry.first().waitFor({ timeout: 60_000 }))
})

test('signed in: chat and settings', async ({ browser }) => {
  const page = await signedInPage(browser)
  test.skip(!page, 'signed-in screens unreachable for this target, see the report coverage note')
  if (!page) {
    return
  }

  const inApp = () => inAppOrOnboarding(page).waitFor({ timeout: 60_000 })
  await auditScreen(page, 'Chat home', inApp)
  // The account menu only exists for a signed-in account; anonymous deployments don't show it.
  const accountMenu = page.getByRole('button', { name: 'Account menu' })
  if (await accountMenu.isVisible()) {
    await checkFocusReturn(page, 'Chat home', accountMenu, 'the account menu')
  }
  await checkFocusReturn(page, 'Chat home', page.getByRole('button', { name: 'Search' }).first(), 'the search palette')

  for (const [state, path] of settingsScreens) {
    await page.goto(path)
    const heading = () => page.getByRole('heading').first().waitFor({ timeout: 60_000 })
    await heading()
    await auditScreen(page, state, heading)
  }

  if (process.env.A11Y_PROMPTS === '1') {
    await page.goto('/')
    await ask(page, 'What is the capital of France, and why did it become the capital?')
    await auditScreen(page, 'Chat answer', () => assistantCopyButtons(page).last().waitFor({ timeout: 60_000 }))
  } else {
    addNote('Chat answer screen was not audited: set A11Y_PROMPTS=1 to send a real prompt (needs a working model).')
  }
})
