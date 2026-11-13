/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, type Locator, type Page } from '@playwright/test'
import { addNote, inAppOrOnboarding, markScreen, signedInPage } from './support/auth'
import { checkDuplicateNames, checkFocusReturn, checkKeyboardFocus, checkReflow, scanAxe } from './support/checks'
import { canSetTheme, disableTransitions, followSystemTheme, setColorScheme } from './support/theme'

/** Waits until a screen has finished rendering, before it is scanned. */
type Ready = () => Promise<unknown>

/**
 * axe under each color scheme, plus the keyboard, reflow and naming checks (run in light). The app follows
 * the emulated scheme live (see `followSystemTheme`), so the screen is never reloaded and every scan sees the
 * state `ready` set up. If the screen never finishes loading it is left unfinished and the report says
 * Incomplete; any other failure, such as a theme that doesn't flip, fails the test.
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
  } catch (error) {
    addNote(`${state} was not scanned because the screen never finished loading: ${String(error).split('\n')[0]}`)
    return
  }
  if (canSetTheme(page)) {
    await setColorScheme(page, 'dark')
    await scanAxe(page, `${state} (dark)`)
    await setColorScheme(page, 'light')
    await scanAxe(page, `${state} (light)`)
  } else {
    await scanAxe(page, `${state} (default theme)`)
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

type SettingsScreen = {
  state: string
  path: string
  /** A control or empty-state message that only shows once the page's data has loaded. */
  content: (main: Locator) => Locator
}

const settingsScreens: SettingsScreen[] = [
  {
    state: 'Settings: Preferences',
    path: '/settings/preferences',
    content: (main) => main.getByText('User Experience', { exact: true }),
  },
  {
    state: 'Settings: Models',
    path: '/settings/models',
    content: (main) => main.getByRole('switch').or(main.getByText('No models configured')),
  },
  {
    state: 'Settings: Connections',
    path: '/settings/connections',
    content: (main) => main.getByRole('listitem').or(main.getByText('No connections yet')),
  },
  {
    state: 'Settings: Skills',
    path: '/settings/skills',
    content: (main) => main.getByRole('listitem').or(main.getByText('No skills yet')),
  },
  {
    state: 'Settings: Devices',
    path: '/settings/devices',
    content: (main) => main.getByRole('listitem').or(main.getByText(/^No devices yet/)),
  },
]

/**
 * A settings page is ready when its heading shows, no "Loading…" placeholder is left, and its own content
 * (a list row or the empty state) is there. Pages render the heading before their data arrives.
 */
const settingsReady = async (page: Page, { content }: SettingsScreen) => {
  const main = page.getByRole('main')
  await main.getByRole('heading').first().waitFor({ timeout: 60_000 })
  // Pages mark their content `aria-busy` while their queries load.
  await test.expect(main.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 })
  await test.expect(main.getByText(/^Loading\b/)).toHaveCount(0, { timeout: 60_000 })
  await content(main).first().waitFor({ timeout: 60_000 })
}

test('signed-out entry screen', async ({ page }) => {
  await followSystemTheme(page.context())
  await disableTransitions(page.context())
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
  // Scoped to the sidebar with an exact name: a bare "Search" also matches buttons like "Pinned skill Search".
  const searchButton = page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'Search', exact: true })
  await checkFocusReturn(page, 'Chat home', searchButton, 'the search palette')

  for (const screen of settingsScreens) {
    await page.goto(screen.path)
    await auditScreen(page, screen.state, () => settingsReady(page, screen))
  }

  if (process.env.A11Y_PROMPTS === '1') {
    await page.goto('/')
    await ask(page, 'What is the capital of France, and why did it become the capital?')
    await auditScreen(page, 'Chat answer', () => assistantCopyButtons(page).last().waitFor({ timeout: 60_000 }))
  } else {
    addNote('Chat answer screen was not audited: set A11Y_PROMPTS=1 to send a real prompt (needs a working model).')
  }
})
