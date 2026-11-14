/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import type { BrowserContext, Page } from '@playwright/test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { loginViaEmailCode, sendChatPrompt } from './helpers'
import { expect } from './test'

const chooseFakeModel = async (page: Page) => {
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')
}

/** The side view: a panel on desktop, a full-screen dialog on a phone. */
export const contentView = (page: Page) =>
  (page.viewportSize()?.width ?? 1280) < 768 ? page.getByRole('dialog') : page.getByTestId('content-view')

/** Attaches a file, sends it, and waits for the answer, which moves the chat to its own URL. */
export const sendAttachment = async (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => {
  await loginViaEmailCode(page)
  await chooseFakeModel(page)
  await page.locator('input[type="file"]').setInputFiles(file)
  await sendChatPrompt(page, 'What is in this file?')
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
}

/** Opens a sent attachment's card in the side view. Its thumbnail frame shares the card's title, so match the button. */
export const openPreview = async (page: Page, name: string) => {
  await page.locator(`button[title="${name}"]`).click()
  return contentView(page).locator(`iframe[title="${name}"]`)
}

/** The desktop app's policy, as `tauri.conf.json` declares it. */
const appCsp = () => {
  const { app } = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  return Object.entries<string>(app.security.csp)
    .map(([directive, sources]) => `${directive} ${sources}`)
    .join('; ')
}

const escapeAttribute = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

/**
 * Shows a snapshot the app made in a page served with the desktop app's policy, which a frame with `srcdoc` inherits.
 * The e2e servers send the self-hosted web headers instead, which set no policy for the page. `requests` lists what
 * reached the network besides the page: Chromium also reports a request a policy blocked, which never does.
 */
export const openUnderAppCsp = async (context: BrowserContext, snapshot: string) => {
  const page = await context.newPage()
  const requests: string[] = []
  await page.route(
    (url) => url.href !== 'https://app-csp.test/',
    (route) => {
      requests.push(route.request().url())
      return route.abort()
    },
  )
  await page.route('https://app-csp.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': appCsp() },
      body: `<!DOCTYPE html><iframe title="snapshot" sandbox="" style="width:900px;height:900px" srcdoc="${escapeAttribute(snapshot)}"></iframe>`,
    }),
  )
  await page.goto('https://app-csp.test/')
  return { page, frame: page.frameLocator('iframe[title="snapshot"]'), requests }
}
