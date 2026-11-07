/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectPageErrors, openSidebarOnMobile } from './helpers'
import { installMapStyleFixture, mapStyleUrl, prepareMapHistory } from './map-fixture'
import { expect, test } from './test'

test('history maps initialize near the viewport and retain their instance after scrolling away', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'firefox', 'Headless Firefox on the GPU-less Linux runner has no WebGL2 for MapLibre')
  test.setTimeout(120_000)
  const errors = collectPageErrors(page)
  const styleRequests: string[] = []
  page.on('request', (request) => {
    if (request.url() === mapStyleUrl) {
      styleRequests.push(request.url())
    }
  })
  await installMapStyleFixture(page)
  await prepareMapHistory(page)
  const first = page.getByText('Map history 21', { exact: true }).locator('..')
  const second = page.getByText('Map history 25', { exact: true }).locator('..')
  await expect(first).not.toBeInViewport()
  const before = (await first.boundingBox())!
  await page.waitForTimeout(500)
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0)
  expect(styleRequests).toHaveLength(0)

  await first.scrollIntoViewIfNeeded()
  const canvas = first.locator('.maplibregl-canvas')
  await expect(canvas).toBeVisible()
  await expect(first.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible()
  await expect(first.locator('[data-slot="skeleton"]')).toHaveCount(0)
  await expect.poll(() => styleRequests.length).toBe(1)
  const after = (await first.boundingBox())!
  expect(after.width).toBe(before.width)
  expect(after.height).toBe(before.height)
  await expect(second.locator('.maplibregl-canvas')).toHaveCount(0)
  // An unchanged canvas identity proves scrolling did not replace the map and reset its pan/zoom.
  await canvas.evaluate((element) => element.setAttribute('data-retained-map', 'original'))
  await first.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await canvas.click({ position: { x: after.width / 2, y: 160 } })
  await expect(first.locator('.maplibregl-popup')).toContainText('Seattle')

  await page.locator('[data-message-id]').last().scrollIntoViewIfNeeded()
  await expect(first).not.toBeInViewport()
  await expect(canvas).toHaveAttribute('data-retained-map', 'original')
  await first.scrollIntoViewIfNeeded()
  await expect(canvas).toHaveAttribute('data-retained-map', 'original')
  await expect(first.locator('.maplibregl-popup')).toContainText('Seattle')
  expect(styleRequests).toHaveLength(1)
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0)
  expect(errors).toEqual([])
})
