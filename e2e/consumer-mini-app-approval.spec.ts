/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page, Route } from '@playwright/test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import {
  miniAppGuestHtml,
  miniAppOrigin,
  miniAppTool,
  miniAppTransferPrompt,
  protectedEmailBody,
  protectedEmailId,
} from './mini-app-fixture'
import { expect, test } from './test'

// Mini Apps are desktop only, gated on viewport width (`useIsMobile`): a narrow viewport shows a notice instead.
test.skip(({ viewport }) => (viewport?.width ?? 1280) < 768, 'Mini Apps are only available on desktop')

const appId = 'e2e-notes'
const appName = 'E2E Notes'
const googleEmail = 'e2e-gmail@gmail.test'

const corsHeaders = (route: Route) => ({
  'Access-Control-Allow-Origin': route.request().headers().origin ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
})

type FulfillOptions = NonNullable<Parameters<Route['fulfill']>[0]>

/** Answer a cross-origin request to Google, including the CORS preflight the browser sends for it. */
const fulfillGoogle = (route: Route, options: FulfillOptions) =>
  route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: corsHeaders(route) })
    : route.fulfill({ ...options, headers: corsHeaders(route) })

/**
 * Stubs the outside world this flow touches: the operator's app registry, the app's own origin, and Google. The chat,
 * the Gmail tool, the model loop, the bridge and the approval prompt in between are the real app.
 */
const stubOutsideWorld = async (page: Page, hostOrigin: string) => {
  await page.route('**/v1/mini-apps', (route) =>
    route.fulfill({
      json: {
        apps: [
          {
            id: appId,
            name: appName,
            description: 'Shows notes.',
            icon: 'table',
            url: `${miniAppOrigin}/`,
            origin: miniAppOrigin,
          },
        ],
      },
    }),
  )
  await page.route(`${miniAppOrigin}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: miniAppGuestHtml(hostOrigin),
      headers: {
        'Content-Security-Policy': `frame-ancestors 'self' ${hostOrigin}`,
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    }),
  )
  await page.route('**/v1/auth/google/config', (route) =>
    route.fulfill({ json: { configured: true, client_id: 'e2e-google-client' } }),
  )
  await page.route('https://accounts.google.com/o/oauth2/v2/auth**', (route) => {
    const authUrl = new URL(route.request().url())
    const callback = new URL(authUrl.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'e2e-google-code')
    callback.searchParams.set('state', authUrl.searchParams.get('state')!)
    // WebKit cannot fulfill a request with a redirect status, so the page does the redirect.
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><script>location.replace(${JSON.stringify(callback.href)})</script>`,
    })
  })
  await page.route('**/v1/auth/google/exchange', (route) =>
    route.fulfill({
      json: { access_token: 'e2e-google-access', refresh_token: 'e2e-google-refresh', expires_in: 3600 },
    }),
  )
  await page.route('https://www.googleapis.com/oauth2/v2/userinfo', (route) =>
    fulfillGoogle(route, { json: { email: googleEmail, name: 'E2E Gmail' } }),
  )
  await page.route(`https://www.googleapis.com/gmail/v1/users/me/messages/${protectedEmailId}`, (route) =>
    fulfillGoogle(route, {
      json: {
        id: protectedEmailId,
        threadId: protectedEmailId,
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Bank <alerts@bank.test>' },
            { name: 'To', value: googleEmail },
            { name: 'Subject', value: 'Your statement' },
          ],
          body: { data: Buffer.from(protectedEmailBody).toString('base64url') },
        },
      },
    }),
  )
}

const connectGoogle = async (page: Page) => {
  await page.goto('/settings/connections')
  await page.getByRole('button', { name: 'New Connection' }).click()
  await page.getByRole('button', { name: 'Google Productivity' }).click()
  await page.getByRole('button', { name: 'Connect Google' }).click()
  await expect(page.getByRole('switch', { name: 'Disable Google' })).toBeVisible()
}

/** What reached the app's origin: the guest lists every note a tool call delivered. */
const receivedNotes = (page: Page) => page.frameLocator(`iframe[title="${appName}"]`).locator('#received li')

const askForTransfer = async (page: Page) => {
  await page.getByRole('textbox', { name: 'Ask me anything…' }).fill(miniAppTransferPrompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

const openAppChat = async (page: Page) => {
  await page.goto(`/apps/${appId}`)
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
}

/** The Anthropic route answers from the local fake provider, which plays a model that obeys the app. */
const pickFakeModel = async (page: Page) => {
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')
}

const approvalPrompt = (page: Page) => page.getByRole('dialog', { name: miniAppTool.annotations.title })

test('a Mini App cannot receive email data through a tool it calls read-only without approval', async ({
  page,
  baseURL,
}) => {
  const errors = collectPageErrors(page)
  await stubOutsideWorld(page, new URL(baseURL!).origin)
  await loginViaEmailCode(page)
  await connectGoogle(page)
  await openAppChat(page)
  await pickFakeModel(page)

  await askForTransfer(page)
  const approval = approvalPrompt(page)
  await expect(approval).toContainText(protectedEmailBody)
  await expect(approval).toContainText(`Approving sends this request, with the details shown, to ${appName}.`)
  // The prompt is waiting, so nothing may have reached the frame yet.
  await expect(receivedNotes(page)).toHaveCount(0)
  await approval.getByRole('button', { name: 'Deny' }).click()
  await expect(approval).toBeHidden()
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  await expect(receivedNotes(page)).toHaveCount(0)

  await askForTransfer(page)
  // Exact, so it cannot also match "Always approve this action".
  await approval.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(receivedNotes(page)).toHaveText([protectedEmailBody])

  expect(errors).toEqual([])
})

test('Always approve stops asking about that tool until Thunderbolt reloads', async ({ page, baseURL }) => {
  const errors = collectPageErrors(page)
  await stubOutsideWorld(page, new URL(baseURL!).origin)
  await loginViaEmailCode(page)
  await connectGoogle(page)
  await openAppChat(page)
  await pickFakeModel(page)

  await askForTransfer(page)
  const approval = approvalPrompt(page)
  await approval.getByRole('button', { name: 'Always approve this action' }).click()
  await expect(receivedNotes(page)).toHaveText([protectedEmailBody])

  // Nobody answers a prompt this time, so the second note arriving proves none was needed.
  await askForTransfer(page)
  await expect(receivedNotes(page)).toHaveText([protectedEmailBody, protectedEmailBody])
  await expect(approval).toBeHidden()

  // `goto` is a full page load, which is what forgets the allowance. The model pick survives it.
  await openAppChat(page)
  await askForTransfer(page)
  await expect(approval).toBeVisible()
  await expect(receivedNotes(page)).toHaveCount(0)

  expect(errors).toEqual([])
})
