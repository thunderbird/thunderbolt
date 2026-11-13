/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Browser, type Page } from '@playwright/test'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { followSystemTheme } from './theme'

export const notesPath = join(import.meta.dirname, '..', 'notes.jsonl')

/** Record a line for the "Coverage" section of the report. */
export const addNote = (note: string) => appendFileSync(notesPath, `${JSON.stringify({ note })}\n`)

/** Record that a screen's audit began or finished, so the report can tell a finished run from a cut-off one. */
export const markScreen = (progress: 'started' | 'completed', screen: string) =>
  appendFileSync(notesPath, `${JSON.stringify({ [progress]: screen })}\n`)

const baseUrl = new URL(process.env.A11Y_BASE_URL ?? 'http://localhost:1420')
const isLocal = ['localhost', '127.0.0.1'].includes(baseUrl.hostname)

/**
 * Local servers and PR previews are throwaway. Anything else (production) is only read unless
 * `A11Y_SIGNED_IN=1`, because a signed-in run there creates an anonymous account, writes synced
 * settings during onboarding and sends analytics events.
 */
const mayWrite = isLocal || baseUrl.hostname.endsWith('.preview.thunderbolt.io') || process.env.A11Y_SIGNED_IN === '1'

export const onboardingWizard = (page: Page) => page.getByRole('dialog', { name: 'Onboarding Wizard' })

/** The sidebar Search button once in the app, or the onboarding wizard that covers it (and hides it from the a11y tree). */
export const inAppOrOnboarding = (page: Page) =>
  page.getByRole('button', { name: 'Search' }).or(onboardingWizard(page)).first()

/** Sign in through the shared Keycloak that PR previews use. */
const signInWithKeycloak = async (page: Page) => {
  await page.locator('#username').fill(process.env.A11Y_USERNAME ?? 'demo')
  await page.locator('#password').fill(process.env.A11Y_PASSWORD ?? 'demo')
  await page.locator('#kc-login').click()
}

/**
 * Sign in with an emailed code. Only works against a backend that accepts a fixed code
 * (the local e2e stack), supplied as `A11Y_SIGN_IN_CODE`.
 */
const signInWithEmailCode = async (page: Page, code: string) => {
  await page.getByPlaceholder('Email', { exact: true }).fill(`a11y-${crypto.randomUUID()}@thunderbolt.test`)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.locator('input[autocomplete="one-time-code"]').fill(code)
}

/** Accept the terms and step through the onboarding wizard, skipping every optional step. */
export const skipOnboarding = async (page: Page) => {
  const wizard = onboardingWizard(page)
  await wizard.waitFor({ timeout: 10_000 }).catch(() => undefined)
  if (!(await wizard.isVisible())) {
    return
  }
  await wizard.getByRole('checkbox').check()
  for (let step = 0; step < 10 && (await wizard.isVisible()); step++) {
    const next = wizard.getByRole('button', { name: /^(Skip|Continue)$/ })
    const enabled = await next.evaluateAll((buttons) => buttons.findIndex((b) => !(b as HTMLButtonElement).disabled))
    const before = await wizard.textContent()
    // The last Continue closes the wizard, which animates out: a click that fails because the wizard is
    // gone means onboarding is done, not that it's stuck.
    const clicked = await next
      .nth(Math.max(enabled, 0))
      .click()
      .then(
        () => true,
        async (error: unknown) => {
          if (await wizard.isVisible()) {
            throw error
          }
          return false
        },
      )
    if (!clicked) {
      return
    }
    // Wait for the next step to render (or the wizard to close) rather than sleeping.
    await expect(wizard)
      .not.toHaveText(before ?? '')
      .catch(() => undefined)
  }
}

/** Dismiss the welcome dialog if it appears over the chat. */
const dismissWelcome = async (page: Page) => {
  const welcome = page.getByRole('dialog', { name: 'Welcome', exact: true })
  if (
    await welcome.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await welcome.getByRole('button', { name: 'Continue', exact: true }).click()
  }
}

/** What the unauthenticated app shows at `/`. */
type EntryScreen = 'keycloak' | 'email' | 'chat'

/** Open `/` and report which entry screen appears first, or `null` if none does within a minute. */
const detectEntryScreen = async (page: Page): Promise<EntryScreen | null> => {
  await page.goto('/')
  const screens: [EntryScreen, ReturnType<Page['locator']>][] = [
    ['keycloak', page.locator('#kc-login')],
    ['email', page.getByPlaceholder('Email', { exact: true })],
    ['chat', inAppOrOnboarding(page)],
  ]
  return Promise.any(
    screens.map(async ([name, locator]) => (await locator.waitFor({ state: 'attached', timeout: 60_000 }), name)),
  ).catch(() => null)
}

/**
 * A fresh browser session on a new chat, signed in when the target allows it.
 * Returns `null` (and records why) when it can only reach the signed-out screens.
 */
export const signedInPage = async (browser: Browser): Promise<Page | null> => {
  if (!mayWrite) {
    addNote(
      'Signed-in screens were not audited: this target is not local or a PR preview, and a signed-in run would create an anonymous account and complete onboarding there. Set A11Y_SIGNED_IN=1 to allow it.',
    )
    return null
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await followSystemTheme(context)
  const page = await context.newPage()
  const entry = await detectEntryScreen(page)

  if (entry === 'keycloak') {
    await signInWithKeycloak(page)
  } else if (entry === 'email' && process.env.A11Y_SIGN_IN_CODE && !isLocal) {
    addNote(
      'Signed-in screens were not audited: A11Y_SIGN_IN_CODE only works against a local e2e stack, not this target.',
    )
    await context.close()
    return null
  } else if (entry === 'email' && process.env.A11Y_SIGN_IN_CODE) {
    await signInWithEmailCode(page, process.env.A11Y_SIGN_IN_CODE)
  } else if (entry !== 'chat') {
    addNote(
      entry === 'email'
        ? 'Signed-in screens were not audited: the target asks for an emailed code and A11Y_SIGN_IN_CODE is not set.'
        : 'Signed-in screens were not audited: no known sign-in screen appeared at /.',
    )
    await context.close()
    return null
  }

  await skipOnboarding(page)
  await dismissWelcome(page)
  const reached = await page
    .getByRole('button', { name: 'Search' })
    .first()
    .waitFor({ timeout: 60_000 })
    .then(
      () => true,
      () => false,
    )
  if (!reached) {
    addNote('Signed-in screens were not audited: sign-in did not reach the app.')
    await context.close()
    return null
  }
  return page
}
