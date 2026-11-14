/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import type { BrowserContext, Page } from '@playwright/test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import {
  hostileAltChunkText,
  hostileDocx,
  hostileDocxProbeOrigin,
  hostileLinkText,
} from '../src/test-utils/hostile-docx'
import { sampleDocx, sampleDocxText } from '../src/test-utils/sample-docx'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode, sendChatPrompt } from './helpers'
import { expect, test } from './test'

const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const chooseFakeModel = async (page: Page) => {
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')
}

/** The side view: a panel on desktop, a full-screen dialog on a phone. */
const contentView = (page: Page) =>
  (page.viewportSize()?.width ?? 1280) < 768 ? page.getByRole('dialog') : page.getByTestId('content-view')

/** Attaches a document, sends it, and waits for the answer, which moves the chat to its own URL. */
const sendDocument = async (page: Page, name: string, buffer: Buffer) => {
  await loginViaEmailCode(page)
  await chooseFakeModel(page)
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: docxMime, buffer })
  await sendChatPrompt(page, 'What is in this document?')
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
}

/** Opens a sent attachment's card in the side view. Its thumbnail frame shares the card's title, so match the button. */
const openPreview = async (page: Page, name: string) => {
  await page.locator(`button[title="${name}"]`).click()
  return contentView(page).locator(`iframe[title="${name}"]`)
}

const sampleBuffer = async () => Buffer.from(await (await sampleDocx()).arrayBuffer())

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
 * The e2e servers send the self-hosted web headers instead, which set no policy for the page.
 */
const openUnderAppCsp = async (context: BrowserContext, snapshot: string) => {
  const page = await context.newPage()
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
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

test('an attached DOCX previews as pages on its card and in the side panel', async ({ page, context }) => {
  const errors = collectPageErrors(page)
  const name = 'e2e-report.docx'
  await sendDocument(page, name, await sampleBuffer())

  const thumbnail = page.locator(`button[title="${name}"] iframe`)
  await expect(thumbnail).toHaveAttribute('sandbox', '')
  await expect(page.frameLocator(`button[title="${name}"] iframe`).getByText(sampleDocxText.title)).toBeVisible()

  const preview = await openPreview(page, name)
  await expect(preview).toHaveAttribute('sandbox', '')
  const pages = contentView(page).frameLocator(`iframe[title="${name}"]`)
  await expect(pages.getByText(sampleDocxText.title)).toBeVisible()
  await expect(pages.getByText(sampleDocxText.bullets[0])).toBeVisible()
  await expect(pages.locator('td', { hasText: 'North' })).toBeVisible()
  const picture = pages.locator('img')
  await expect(picture).toHaveAttribute('src', /^data:image\/png;base64,/)
  expect(await picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(1)
  // Parsed from the snapshot, the picture is still inside its paragraph.
  expect(await picture.evaluate((image) => image.closest('p') !== null)).toBe(true)
  // Headings and lists keep their formatting: the title is larger than a list item, which has a marker.
  const fontSize = (text: string) =>
    pages.getByText(text).evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  expect(await fontSize(sampleDocxText.title)).toBeGreaterThan(await fontSize(sampleDocxText.bullets[0]))
  expect(
    await pages
      .getByText(sampleDocxText.bullets[0])
      .evaluate((element) => getComputedStyle(element.closest('p') ?? element, '::before').content),
  ).toContain('●')

  // The desktop app's policy still lets the snapshot draw its styles and its picture.
  const underCsp = await openUnderAppCsp(context, (await preview.getAttribute('srcdoc')) ?? '')
  await expect(underCsp.frame.getByText(sampleDocxText.title)).toBeVisible()
  expect(
    await underCsp.frame.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth),
  ).toBe(1)
  expect(underCsp.requests).toEqual(['https://app-csp.test/'])
  expect(errors).toEqual([])
})

test('on a phone the page scales down to the width of the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const name = 'e2e-phone.docx'
  await sendDocument(page, name, await sampleBuffer())

  const preview = await openPreview(page, name)
  await expect(preview.contentFrame().getByText(sampleDocxText.title)).toBeVisible()
  // The frame keeps the page's own width and is drawn smaller, once the panel has been measured.
  await expect.poll(() => preview.evaluate((frame: HTMLIFrameElement) => frame.offsetWidth)).toBeGreaterThan(390)
  expect((await preview.boundingBox())?.width).toBeLessThanOrEqual(390)
})

test('a hostile DOCX runs no script and sends no request, with the web headers and the app policy', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page)
  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  // Other origins count only once the preview opens, because the app warms up its model provider at startup. A
  // picture the renderer finds no source for gets `src="null"`; built in the page's own document, it would ask this
  // origin for `null` next to the chat's path.
  const outsideRequests: string[] = []
  const preview = { open: false }
  page.on('request', (request) => {
    const url = request.url()
    if (
      url.startsWith(hostileDocxProbeOrigin) ||
      new URL(url).pathname.endsWith('/null') ||
      (preview.open && !/^(?:https?:\/\/localhost(?::\d+)?\/|blob:|data:|about:)/.test(url))
    ) {
      outsideRequests.push(url)
    }
  })
  const name = 'e2e-hostile.docx'
  await sendDocument(page, name, Buffer.from(hostileDocx()))

  preview.open = true
  const frame = await openPreview(page, name)
  const pages = frame.contentFrame()
  await expect(pages.getByText('Hostile document')).toBeVisible()
  await expect(pages.getByText(hostileAltChunkText)).toHaveCount(0)
  // The blocked picture sits over the link, so the click goes to the link itself.
  await pages.getByText(hostileLinkText).dispatchEvent('click')
  await expect(pages.getByText('Hostile document')).toBeVisible()
  expect(await pages.locator('script, iframe, [href]').count()).toBe(0)
  expect(await page.evaluate(() => '__docxProbe' in window)).toBe(false)

  const underCsp = await openUnderAppCsp(context, (await frame.getAttribute('srcdoc')) ?? '')
  await expect(underCsp.frame.getByText('Hostile document')).toBeVisible()
  await underCsp.frame.getByText(hostileLinkText).dispatchEvent('click')
  expect(underCsp.requests).toEqual(['https://app-csp.test/'])

  expect(outsideRequests).toEqual([])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
})
