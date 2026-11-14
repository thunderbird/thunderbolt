/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { FrameLocator, Page } from '@playwright/test'
import PptxGenJS from 'pptxgenjs'
import { hostileLinkText, hostileMarkupText, hostilePptx, hostilePptxProbeOrigin } from '../src/test-utils/hostile-pptx'
import { samplePptx, samplePptxText } from '../src/test-utils/sample-pptx'
import { collectPageErrors } from './helpers'
import { contentView, openPreview, openUnderAppCsp, sendAttachment } from './office-preview'
import { expect, test } from './test'

const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

const sendDeck = (page: Page, name: string, bytes: Uint8Array) =>
  sendAttachment(page, { name, mimeType: pptxMime, buffer: Buffer.from(bytes) })

/** A deck of `count` slides, each with only its number. */
const deckOfSlides = async (count: number) => {
  const deck = new PptxGenJS()
  for (let index = 1; index <= count; index++) {
    deck.addSlide().addText(`Slide ${index}`, { x: 0.5, y: 0.5, w: 9, h: 1 })
  }
  return (await deck.write({ outputType: 'uint8array' })) as Uint8Array
}

/** Every picture in the frame, with whether it loaded and the start of its `src`. */
const pictures = (frame: FrameLocator) =>
  frame
    .locator('img')
    .evaluateAll((images: HTMLImageElement[]) =>
      images.map((image) => ({ loaded: image.complete && image.naturalWidth > 0, src: image.src.slice(0, 22) })),
    )

test('an attached PPTX shows a deck icon on its card and every slide in the side panel', async ({ page, context }) => {
  const errors = collectPageErrors(page)
  const name = 'e2e-review.pptx'
  await sendDeck(page, name, await samplePptx())

  await expect(page.locator(`button[title="${name}"] .lucide-presentation`)).toBeVisible()

  const preview = await openPreview(page, name)
  await expect(preview).toHaveAttribute('sandbox', '')
  const slides = preview.contentFrame()
  await expect(slides.getByText(samplePptxText.title)).toBeVisible()
  await expect(slides.getByText(samplePptxText.bullets[0])).toBeVisible()
  await expect(slides.getByText('North', { exact: true })).toBeVisible()
  // The picture on the second slide and the chart on the third, which became a picture of itself.
  await expect
    .poll(() => pictures(slides))
    .toEqual([
      { loaded: true, src: 'data:image/png;base64,' },
      { loaded: true, src: 'data:image/png;base64,' },
    ])
  expect(await slides.locator('canvas').count()).toBe(0)

  // The desktop app's policy still lets the snapshot draw its styles and its pictures.
  const underCsp = await openUnderAppCsp(context, (await preview.getAttribute('srcdoc')) ?? '')
  await expect(underCsp.frame.getByText(samplePptxText.title)).toBeVisible()
  await expect.poll(() => pictures(underCsp.frame)).toHaveLength(2)
  expect((await pictures(underCsp.frame)).every(({ loaded }) => loaded)).toBe(true)
  expect(underCsp.requests).toEqual([])
  expect(errors).toEqual([])
})

test('a deck over 200 slides gets a refusal in place of the preview, and Download still saves it', async ({ page }) => {
  const name = 'e2e-long.pptx'
  await sendDeck(page, name, await deckOfSlides(201))

  await page.locator(`button[title="${name}"]`).click()
  await expect(contentView(page).getByText('This presentation is too large to preview')).toBeVisible()
  await expect(contentView(page).locator('iframe')).toHaveCount(0)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    contentView(page).getByRole('button', { name: 'Download' }).click(),
  ])
  expect(download.suggestedFilename()).toBe(name)
})

test('a hostile PPTX loads nothing from outside and runs no script, with the web headers and the app policy', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page)
  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  // A request counts once it reaches the network: one a frame's policy blocks never does. Other origins count only
  // once the preview opens, because the app warms up its model provider at startup.
  const outsideRequests: string[] = []
  const preview = { open: false }
  await page.route(
    (url) =>
      url.origin === hostilePptxProbeOrigin || (preview.open && !/^https?:\/\/localhost(?::\d+)?$/.test(url.origin)),
    (route) => {
      outsideRequests.push(route.request().url())
      return route.abort()
    },
  )
  const name = 'e2e-hostile.pptx'
  await sendDeck(page, name, await hostilePptx())

  preview.open = true
  const frame = await openPreview(page, name)
  const slides = frame.contentFrame()
  await expect(slides.getByText(samplePptxText.title)).toBeVisible()
  // Markup in the deck's text shows as text.
  await expect(slides.getByText(hostileMarkupText)).toBeVisible()
  await slides.getByText(hostileLinkText.script).dispatchEvent('click')
  await slides.getByText(hostileLinkText.web).dispatchEvent('click')
  await expect(slides.getByText(samplePptxText.title)).toBeVisible()
  expect(await slides.locator('script, iframe, [href], [onerror]').count()).toBe(0)
  expect(await page.evaluate(() => '__pptxProbe' in window)).toBe(false)

  const underCsp = await openUnderAppCsp(context, (await frame.getAttribute('srcdoc')) ?? '')
  await expect(underCsp.frame.getByText(samplePptxText.title)).toBeVisible()
  await underCsp.frame.getByText(hostileLinkText.web).dispatchEvent('click')
  expect(underCsp.requests).toEqual([])

  expect(outsideRequests).toEqual([])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
})
