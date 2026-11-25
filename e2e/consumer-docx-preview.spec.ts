/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import type { Locator, Page, Route } from '@playwright/test'
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

/**
 * Counts the lines `table` draws on screen, across and down, in a screenshot of `container`, which must hold the whole
 * table. A line is a row or column of pixels that is dark along nearly all of the table's inside, so a border drawn
 * too thin or too faint is not counted.
 */
const tableLines = async (page: Page, table: Locator, container: Locator) => {
  const [tableBox, containerBox] = await Promise.all([table.boundingBox(), container.boundingBox()])
  if (!tableBox || !containerBox) {
    throw new Error('The table or its container is not on screen')
  }
  const box = { ...tableBox, x: tableBox.x - containerBox.x, y: tableBox.y - containerBox.y }
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(containerBox.width)
  const screenshot = (await container.screenshot({ animations: 'disabled' })).toString('base64')
  return page.evaluate(
    async ({ png, table, width }) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], { type: 'image/png' }),
      )
      const canvas = document.createElement('canvas')
      Object.assign(canvas, { width: bitmap.width, height: bitmap.height })
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0)
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      const dark = (x: number, y: number) => {
        const at = 4 * (y * bitmap.width + x)
        return pixels[at] + pixels[at + 1] + pixels[at + 2] < 3 * 160
      }
      const scale = bitmap.width / width
      // The device pixels from `start` to `end`, given in CSS pixels, kept within the screenshot.
      const span = (start: number, end: number, limit: number) => {
        const from = Math.max(0, Math.round(start * scale))
        return Array.from({ length: Math.min(limit, Math.round(end * scale)) - from }, (_, index) => from + index)
      }
      // A collapsed border lies half outside the table's box, so look 2px past it, but measure only its inside.
      const rows = span(table.y - 2, table.y + table.height + 2, bitmap.height)
      const columns = span(table.x - 2, table.x + table.width + 2, bitmap.width)
      const insideRows = span(table.y + 1, table.y + table.height - 1, bitmap.height)
      const insideColumns = span(table.x + 1, table.x + table.width - 1, bitmap.width)
      const isLine = (line: boolean[]) => line.filter(Boolean).length > 0.9 * line.length
      const count = (lines: boolean[]) => lines.filter((line, index) => line && !lines[index - 1]).length
      return {
        across: count(rows.map((y) => isLine(insideColumns.map((x) => dark(x, y))))),
        down: count(columns.map((x) => isLine(insideRows.map((y) => dark(x, y))))),
      }
    },
    { png: screenshot, table: box, width: containerBox.width },
  )
}

/** The lines of the sample's table: two rows and two columns, with the default borders, 0.5pt, under a pixel. */
const twoByTwo = { across: 3, down: 3 }

test('on a phone the pages reflow to the width of the screen, the text keeps its size, and table borders draw', async ({
  page,
}) => {
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
  // At full size too, WebKit at 3 device pixels per CSS pixel drops such a border unless the table's are separate.
  const table = pages.locator('table')
  await table.scrollIntoViewIfNeeded()
  expect(await tableLines(page, table, preview)).toEqual(twoByTwo)
})

test("a table's thin borders still draw where its pages are drawn smaller, on the card and in the side panel", async ({
  page,
}) => {
  const name = 'e2e-borders.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)

  const card = page.locator(`button[title="${name}"]`)
  const thumbnailTable = card.locator('iframe').contentFrame().locator('table')
  await expect(thumbnailTable).toBeVisible()
  expect(await tableLines(page, thumbnailTable, card)).toEqual(twoByTwo)

  // A phone held upright lays the pages out again at full size; held sideways, its side panel draws them smaller.
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.setViewportSize({ width: 844, height: 390 })
  }
  const preview = await openPreview(page, name)
  const table = preview.contentFrame().locator('table')
  await expect(table).toBeVisible()
  await table.scrollIntoViewIfNeeded()
  expect(await tableLines(page, table, preview)).toEqual(twoByTwo)
})

test('a DOCX card opens from the keyboard, and Escape on the Close button closes the preview', async ({
  page,
  browserName,
}) => {
  const errors = collectPageErrors(page)
  const name = 'e2e-keyboard.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const card = page.locator(`button[title="${name}"]`)
  const isPhone = (page.viewportSize()?.width ?? 1280) < 768
  // The Copy button on the user's message comes right after the card. If the thumbnail's frame took focus, Shift+Tab
  // from there would land inside the frame instead of on the card.
  const focusCardFromBelow = async () => {
    await page.getByRole('button', { name: 'Copy message', exact: true }).first().focus()
    // macOS WebKit uses Option-Tab to include buttons in keyboard navigation.
    await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Shift+Alt+Tab' : 'Shift+Tab')
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

const historyLength = (page: Page) => page.evaluate(() => window.history.length)
const previewHistoryEntry = (page: Page) => page.evaluate(() => window.history.state?.contentViewOpen ?? null)

test('on a phone, Back closes the preview without leaving the chat, and closing it leaves history as it was', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const name = 'e2e-back.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const chatUrl = page.url()
  const lengthBefore = await historyLength(page)
  const dialog = contentView(page)

  await openPreview(page, name)
  await expect(dialog).toBeVisible()
  expect(await historyLength(page)).toBe(lengthBefore + 1)
  await page.goBack()
  await expect(dialog).toBeHidden()
  expect(page.url()).toBe(chatUrl)

  // Closing with the button or with Escape removes the preview's history entry.
  for (const close of [
    () => dialog.getByRole('button', { name: 'Close', exact: true }).first().click(),
    () => page.keyboard.press('Escape'),
  ]) {
    await openPreview(page, name)
    await expect(dialog).toBeVisible()
    await close()
    await expect(dialog).toBeHidden()
    await expect.poll(() => previewHistoryEntry(page)).toBeNull()
    expect(page.url()).toBe(chatUrl)
  }

  // With the preview closed, Back leaves the chat as it did before.
  await page.goBack()
  await expect(page).toHaveURL(/\/chats\/new$/)
})

test('on a phone, leaving the chat from the search palette over the preview costs no extra Back or Forward', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const name = 'e2e-palette.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const chatUrl = page.url()

  const preview = await openPreview(page, name)
  await expect(preview).toBeVisible()
  // The palette opens over the preview, which keeps its history entry under the new route.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('dialog', { name: 'Search', exact: true }).getByRole('option', { name: 'New chat' }).click()
  await expect(page).toHaveURL(/\/chats\/new$/)
  await expect(preview).toBeHidden()

  await page.goBack()
  await expect(page).toHaveURL(chatUrl)
  await expect.poll(() => previewHistoryEntry(page)).toBeNull()
  // The next Back leaves the chat: none is spent on the entry the preview left behind.
  await page.goBack()
  await expect(page).toHaveURL(/\/chats\/new$/)
  await page.goForward()
  await expect(page).toHaveURL(chatUrl)
  await expect.poll(() => previewHistoryEntry(page)).toBeNull()
})

test('on a phone, a preview reopened before its close reached history stays open, and Back closes it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const name = 'e2e-reopen.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const chatUrl = page.url()
  const dialog = contentView(page)

  await openPreview(page, name)
  await expect(dialog).toBeVisible()
  // The close calls history.back() in a microtask, and the reopen lands before the browser carries the Back out.
  const beforeReopen = await page.evaluate(async (fileName) => {
    const back = history.back.bind(history)
    const calls = { back: 0 }
    history.back = () => {
      calls.back += 1
      back()
    }
    const close = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent?.trim() === 'Close',
    )
    close!.click()
    await Promise.resolve()
    await Promise.resolve()
    const state = { backCalls: calls.back, previewEntry: history.state?.contentViewOpen ?? null }
    document.querySelector<HTMLButtonElement>(`button[title="${fileName}"]`)!.click()
    return state
  }, name)
  expect(beforeReopen).toEqual({ backCalls: 1, previewEntry: true })
  await expect(dialog).toBeVisible()
  await expect.poll(() => previewHistoryEntry(page)).toBe(true)

  await page.goBack()
  await expect(dialog).toBeHidden()
  expect(page.url()).toBe(chatUrl)
  await expect.poll(() => previewHistoryEntry(page)).toBeNull()
})

test('on a rotated phone, Back closes the side panel without leaving the chat', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Only a phone or a tablet closes the side panel on Back.')
  // Wide enough for the side panel, as a phone in landscape.
  await page.setViewportSize({ width: 915, height: 412 })
  const name = 'e2e-back-landscape.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const chatUrl = page.url()
  const lengthBefore = await historyLength(page)

  await openPreview(page, name)
  await expect(contentView(page)).toBeVisible()
  expect(await historyLength(page)).toBe(lengthBefore + 1)
  await page.goBack()
  await expect(contentView(page)).toBeHidden()
  expect(page.url()).toBe(chatUrl)
})

test('on desktop, the side panel adds no history entry and Back leaves the chat', async ({ page, isMobile }) => {
  test.skip(isMobile, 'On a phone or a tablet, Back closes the side panel at any width.')
  await page.setViewportSize({ width: 1280, height: 800 })
  const name = 'e2e-back-desktop.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const lengthBefore = await historyLength(page)

  await openPreview(page, name)
  await expect(contentView(page)).toBeVisible()
  expect(await historyLength(page)).toBe(lengthBefore)
  expect(await previewHistoryEntry(page)).toBeNull()

  await page.goBack()
  await expect(page).toHaveURL(/\/chats\/new$/)
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

// The viewer is a lazy chunk: the dev server serves its source module, a build its `/assets/` script and styles.
const viewerChunk = /\/pdf-sidebar-viewer[^/]*\.(?:tsx|js|css)(?:\?|$)/

test('when the side panel viewer does not load, the panel says so, the rest of the app stays up, and Try again loads it', async ({
  page,
}) => {
  await page.route(viewerChunk, (route) => route.abort())
  const name = 'e2e-viewer-offline.docx'
  const buffer = await sampleBuffer()
  await sendDocument(page, name, buffer, sampleDocxText.title)

  // Opened from the keyboard so the card holds focus. Safari does not focus a button on click.
  const card = page.locator(`button[title="${name}"]`)
  await card.focus()
  await page.keyboard.press('Enter')
  await expect(contentView(page).getByText("The preview couldn't load")).toBeVisible()
  await expect(contentView(page).getByText('Try again, or download the file.')).toBeVisible()
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

  const close = contentView(page).getByRole('button', { name: 'Close', exact: true })
  // On desktop, Escape still gives focus back to the card after Try again remounted the viewer.
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await close.click()
  } else {
    await close.focus()
    await page.keyboard.press('Escape')
    await expect(card).toBeFocused()
  }
  await expect(page.locator('textarea')).toBeVisible()
})

test('while the app server does not answer, the side panel asks for no viewer code, and Try again loads it once it does', async ({
  page,
  baseURL,
}) => {
  const name = 'e2e-server-down.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const viewerRequests: string[] = []
  page.on('request', (request) => {
    if (viewerChunk.test(request.url())) {
      viewerRequests.push(request.url())
    }
  })
  const appServer = (url: URL) => url.origin === new URL(baseURL!).origin
  await page.route(appServer, (route) => route.abort())

  await page.locator(`button[title="${name}"]`).click()
  await expect(contentView(page).getByText("The preview couldn't load")).toBeVisible()
  // Safari never fetches a module again once it saw it fail, so the viewer must not be asked for while the server is down.
  expect(viewerRequests).toEqual([])

  await page.unroute(appServer)
  await contentView(page).getByRole('button', { name: 'Try again' }).click()
  await expect(contentView(page).frameLocator(`iframe[title="${name}"]`).getByText(sampleDocxText.title)).toBeVisible()
})

test('when the app server takes the request and never answers, the panel stops waiting, and Try again loads the viewer once it answers', async ({
  page,
  baseURL,
}) => {
  const name = 'e2e-server-silent.docx'
  await sendDocument(page, name, await sampleBuffer(), sampleDocxText.title)
  const appServer = (url: URL) => url.origin === new URL(baseURL!).origin
  const pending: Route[] = []
  // Held, never answered, like a server that accepts the connection and hangs.
  await page.route(appServer, (route) => void pending.push(route))

  await page.locator(`button[title="${name}"]`).click()
  // The check before the import gives up after five seconds.
  await expect(contentView(page).getByText("The preview couldn't load")).toBeVisible({ timeout: 10_000 })
  expect(pending.map((route) => route.request().method())).toContain('HEAD')

  await page.unroute(appServer)
  await contentView(page).getByRole('button', { name: 'Try again' }).click()
  await expect(contentView(page).frameLocator(`iframe[title="${name}"]`).getByText(sampleDocxText.title)).toBeVisible()
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
