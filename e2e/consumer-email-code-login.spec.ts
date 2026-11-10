/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, type Page } from './test'
import { collectPageErrors, enterEmailCode, loginViaEmailCode } from './helpers'

/** Hold a successful real-backend verification until the UI cancels its owner. */
const holdVerificationResponse = async (page: Page) => {
  const responseReady = Promise.withResolvers<void>()
  const releaseResponse = Promise.withResolvers<void>()
  const responseReleased = Promise.withResolvers<void>()
  await page.route('**/api/auth/sign-in/email-otp', async (route) => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    expect(response.headers()['set-auth-token']).toBeTruthy()
    responseReady.resolve()
    await releaseResponse.promise
    await route.fulfill({ response })
    responseReleased.resolve()
  })
  return {
    ready: responseReady.promise,
    release: async () => {
      releaseResponse.resolve()
      await responseReleased.promise
    },
  }
}

/** Cancellation must leave both persistent authentication stores empty. */
const expectNoPublishedSession = async (page: Page) => {
  expect(
    await page.evaluate(() => ({
      token: localStorage.getItem('thunderbolt_auth_token'),
      session: localStorage.getItem('thunderbolt_session_cache'),
    })),
  ).toEqual({ token: null, session: null })
}

/** Open the real reauthentication modal through the event used by session expiry. */
const requestModalCode = async (page: Page) => {
  await page.goto('/')
  await expect(page.getByPlaceholder('Email', { exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('show_sign_in_modal')))
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Email address', { exact: true }).fill(`e2e-${crypto.randomUUID()}@thunderbolt.test`)
  const requested = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/waitlist/join')
  await dialog.getByRole('button', { name: 'Send Magic Link', exact: true }).click()
  expect((await requested).ok()).toBe(true)
  await expect(dialog.locator('input[data-input-otp]')).toBeEnabled()
  return dialog
}

/** Exercise email entry and code verification through the authenticated chat landing. */
test('anonymous user signs in with the code sent by email and lands on the chat', async ({ page }) => {
  const errors = collectPageErrors(page)

  await loginViaEmailCode(page)

  await expect(page).toHaveURL(/\/chats\//)
  await expect(page.locator('textarea')).toBeVisible()
  expect(errors).toEqual([])
})

// At mobile width the modal pins its close button top-left, where this step's back button sits.
for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport })

    test('going back during OTP verification aborts the request without publishing its session', async ({ page }) => {
      const verification = await holdVerificationResponse(page)
      const dialog = await requestModalCode(page)
      await dialog.locator('input[data-input-otp]').fill('12345678')
      await verification.ready
      await expect(dialog.getByText('Verifying…', { exact: true })).toBeVisible()
      const aborted = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/sign-in/email-otp'))
      await dialog.getByRole('button', { name: 'Go back', exact: true }).click()
      await expect(dialog.getByPlaceholder('Email address', { exact: true })).toBeVisible()
      await verification.release()
      expect((await aborted).failure()).not.toBeNull()

      await expectNoPublishedSession(page)
      await expect(page.locator('textarea')).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: 'Send Magic Link', exact: true })).toBeEnabled()
    })
  })
}

test('leaving the waitlist during OTP verification aborts without publishing its session', async ({ page }) => {
  const verification = await holdVerificationResponse(page)
  await enterEmailCode(page)
  await verification.ready
  const aborted = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/sign-in/email-otp'))
  // Drive the router in the same document: a full page navigation would abort
  // fetch itself and hide missing cleanup in the unmounted waitlist form.
  await page.evaluate(() => {
    history.pushState(history.state, '', '/signed-out')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByRole('heading', { name: 'Signed Out', exact: true })).toBeVisible()
  await verification.release()
  expect((await aborted).failure()).not.toBeNull()
  await expectNoPublishedSession(page)
  await expect(page).toHaveURL(/\/signed-out$/)
})

test('a pending resend disables code entry and a failed resend preserves verification', async ({ page }) => {
  const dialog = await requestModalCode(page)
  const otp = dialog.locator('input[data-input-otp]')
  await otp.fill('123')

  const resendStarted = Promise.withResolvers<void>()
  const failResend = Promise.withResolvers<void>()
  await page.route('**/v1/waitlist/join', async (route) => {
    resendStarted.resolve()
    await failResend.promise
    await route.fulfill({ status: 503, json: { message: 'Resend temporarily unavailable.' } })
  })
  await dialog.getByRole('button', { name: 'Resend Email', exact: true }).click()
  await resendStarted.promise
  await expect(otp).toBeDisabled()
  await expect(otp).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Go back', exact: true })).toBeEnabled()

  failResend.resolve()
  await expect(dialog.getByText('Resend temporarily unavailable.', { exact: true })).toBeVisible()
  await expect(otp).toBeEnabled()
  await expect(otp).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Resend Email', exact: true })).toBeEnabled()

  // The original challenge is still valid after the failed resend.
  const verified = page.waitForResponse((response) => response.url().endsWith('/sign-in/email-otp'))
  await otp.fill('12345678')
  const verification = await verified
  expect(verification.request().postDataJSON()).toMatchObject({ otp: '12345678' })
  expect(verification.ok(), await verification.text()).toBe(true)
  await expect(page).toHaveURL(/\/chats\//)
  await expect(page.locator('textarea')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('thunderbolt_auth_token'))).toBeTruthy()
})
