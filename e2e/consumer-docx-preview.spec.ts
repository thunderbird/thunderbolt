/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import {
  hostileAltChunkText,
  hostileDocx,
  hostileDocxProbeOrigin,
  hostileLinkText,
} from '../src/test-utils/hostile-docx'
import { sampleDocx, sampleDocxText } from '../src/test-utils/sample-docx'
import { collectPageErrors } from './helpers'
import { contentView, openPreview, openUnderAppCsp, sendAttachment } from './office-preview'
import { expect, isolateProviderRequests, test } from './test'

const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const sendDocument = (page: Page, name: string, buffer: Buffer, fileText: string) =>
  sendAttachment(page, { name, mimeType: docxMime, buffer }, fileText)

const sampleBuffer = async () => Buffer.from(await (await sampleDocx()).arrayBuffer())

test('an attached DOCX previews as pages on its card and in the side panel', async ({ page, context }) => {
  const errors = collectPageErrors(page)
  const name = 'e2e-report.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)

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
  expect(underCsp.requests).toEqual([])
  expect(errors).toEqual([])
})

test('on a phone the pages reflow to the width of the screen, and the text keeps its size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const name = 'e2e-phone.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)

  const preview = await openPreview(page, name)
  const pages = preview.contentFrame()
  await expect(pages.getByText(sampleDocxText.title)).toBeVisible()
  // The frame is as wide as the screen and drawn at full size, so the text is not scaled down.
  expect(await preview.evaluate((frame: HTMLIFrameElement) => frame.offsetWidth)).toBeLessThanOrEqual(390)
  expect(await preview.evaluate((frame: HTMLIFrameElement) => frame.style.transform)).toBe('')
  const fontSize = await pages
    .getByText(sampleDocxText.bullets[0])
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  expect(fontSize).toBeGreaterThanOrEqual(12)
})

test('a DOCX card opens from the keyboard, and Escape on the Close button closes the preview', async ({ page }) => {
  const errors = collectPageErrors(page)
  const name = 'e2e-keyboard.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const card = page.locator(`button[title="${name}"]`)
  const isPhone = (page.viewportSize()?.width ?? 1280) < 768
  // The Copy button on the user's message comes right after the card. If the thumbnail's frame took focus, Shift+Tab
  // from there would land inside the frame instead of on the card.
  const focusCardFromBelow = async () => {
    await page.getByRole('button', { name: 'Copy message', exact: true }).first().focus()
    await page.keyboard.press('Shift+Tab')
    await expect(card).toBeFocused()
  }
  await expect(card.locator('iframe')).toBeAttached()

  // Tabbing is a desktop path; a phone focuses the card directly.
  await (isPhone ? card.focus() : focusCardFromBelow())
  await page.keyboard.press('Enter')
  await expect(contentView(page).getByRole('heading', { name, exact: true })).toBeVisible()
  await contentView(page).getByRole('button', { name: 'Close', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(contentView(page)).toBeHidden()
  // Only the desktop side panel hands focus back to the card that opened it; the phone's dialog leaves it on the page.
  if (isPhone) {
    await card.focus()
  } else {
    await expect(card).toBeFocused()
    await focusCardFromBelow()
  }

  await page.keyboard.press(' ')
  await expect(contentView(page).getByRole('heading', { name, exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('when the preview code does not load, the panel says so and Download still saves the file', async ({ page }) => {
  // The renderer is its own module, so a broken connection can fail it alone.
  await page.route(/\/docx-snapshot[^/]*\.(?:ts|js)(?:\?|$)/, (route) => route.abort())
  const name = 'e2e-offline.docx'
  const buffer = await sampleBuffer()
  await sendDocument(page, name, buffer, sampleDocxText.title)

  await page.locator(`button[title="${name}"]`).click()
  await expect(contentView(page).getByText("The preview couldn't load")).toBeVisible()
  await expect(contentView(page).locator('iframe')).toHaveCount(0)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    contentView(page).getByRole('button', { name: 'Download' }).click(),
  ])
  expect(download.suggestedFilename()).toBe(name)
  expect(await readFile(await download.path())).toEqual(buffer)
})

test('when the side panel viewer does not load, the panel says so, the rest of the app stays up, and Try again loads it', async ({
  page,
}) => {
  // The viewer is a lazy chunk: the dev server serves its source module, a build its `/assets/` script and styles.
  const viewerChunk = /\/pdf-sidebar-viewer[^/]*\.(?:tsx|js|css)(?:\?|$)/
  await page.route(viewerChunk, (route) => route.abort())
  const name = 'e2e-viewer-offline.docx'
  const buffer = await sampleBuffer()
  await sendDocument(page, name, buffer, sampleDocxText.title)

  await page.locator(`button[title="${name}"]`).click()
  await expect(contentView(page).getByText("The preview couldn't load")).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    contentView(page).getByRole('button', { name: 'Download' }).click(),
  ])
  expect(download.suggestedFilename()).toBe(name)
  expect(await readFile(await download.path())).toEqual(buffer)

  // Back online, Try again loads the viewer without reloading the app.
  await page.unroute(viewerChunk)
  await contentView(page).getByRole('button', { name: 'Try again' }).click()
  await expect(contentView(page).frameLocator(`iframe[title="${name}"]`).getByText(sampleDocxText.title)).toBeVisible()

  await contentView(page).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('textarea')).toBeVisible()
})

test('in a private window an attached file still downloads whole', async ({ browser, baseURL }, testInfo) => {
  // The WebKit Nightly runs each test in a saved profile. A new context keeps storage in memory, like Safari's private
  // browsing.
  const context = await browser.newContext({ baseURL })
  await isolateProviderRequests(context, testInfo.project.name)
  const page = await context.newPage()
  const name = 'e2e-private.docx'
  const buffer = await sampleBuffer()
  await sendDocument(page, name, buffer, sampleDocxText.title)

  await page.locator(`button[title="${name}"]`).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    contentView(page).getByRole('button', { name: 'Download' }).click(),
  ])
  expect(await readFile(await download.path())).toEqual(buffer)
  await context.close()
})

test('a right-to-left override is dropped from a file name, so the name reads in order', async ({ page }) => {
  // Left in, the override would draw everything after it right to left.
  const shown = 'e2e-xcod.docx'
  await sendDocument(page, `e2e-${String.fromCodePoint(0x202e)}xcod.docx`, await sampleBuffer(), sampleDocxText.title)

  await expect(page.getByText(shown, { exact: true })).toBeVisible()
  await page.locator(`button[title="${shown}"]`).click()
  await expect(contentView(page).getByRole('heading', { name: shown, exact: true })).toBeVisible()
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
  await sendDocument(page, name, Buffer.from(hostileDocx()), 'Hostile document')

  preview.open = true
  const frame = await openPreview(page, name)
  await expect(frame).toHaveAttribute('sandbox', '')
  const pages = frame.contentFrame()
  await expect(pages.getByText('Hostile document')).toBeVisible()
  await expect(pages.getByText(hostileAltChunkText)).toHaveCount(0)
  // The blocked picture sits over the link, so the click goes to the link itself.
  await pages.getByText(hostileLinkText).dispatchEvent('click')
  await expect(pages.getByText('Hostile document')).toBeVisible()
  expect(await pages.locator('script, iframe, meta[http-equiv="refresh" i], [href], [onerror]').count()).toBe(0)
  expect(await page.evaluate(() => '__docxProbe' in window)).toBe(false)
  // A script that ran would have set the probe in the frame's own window, not the app's.
  expect(await pages.locator('body').evaluate(() => '__docxProbe' in window)).toBe(false)

  const underCsp = await openUnderAppCsp(context, (await frame.getAttribute('srcdoc')) ?? '')
  await expect(underCsp.frame.getByText('Hostile document')).toBeVisible()
  await underCsp.frame.getByText(hostileLinkText).dispatchEvent('click')
  expect(underCsp.requests).toEqual([])

  expect(outsideRequests).toEqual([])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
})
