/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test'
import { expect, test } from './test'
import { collectPageErrors, loginViaEmailCode } from './helpers'

const pinnedChips = (page: Page) => page.getByRole('button', { name: /^Pinned skill / })

/** A pinned widget skill can move past other pins, and the new order survives a reload. */
test('a pinned widget skill can be reordered', async ({ page }) => {
  const errors = collectPageErrors(page)
  const mobile = (page.viewportSize()?.width ?? 1280) < 768
  await loginViaEmailCode(page)

  await expect(pinnedChips(page)).toHaveText(['Search', 'Research', 'Weather'], { timeout: 30_000 })

  await page.getByRole('button', { name: 'Pinned skill Weather', exact: true }).click({ button: 'right' })
  await page.getByRole(mobile ? 'button' : 'menuitem', { name: 'Reorder', exact: true }).click()

  // Drag the Weather row above Search. Moving a few pixels first crosses the pointer
  // sensor's activation distance; the stepped move lets dnd-kit track the pointer.
  const rows = page.locator('[aria-roledescription="sortable"]')
  const weatherRow = (await rows.filter({ hasText: /^Weather$/ }).boundingBox())!
  const searchRow = (await rows.filter({ hasText: /^Search$/ }).boundingBox())!
  const x = weatherRow.x + 20
  await page.mouse.move(x, weatherRow.y + weatherRow.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, weatherRow.y + weatherRow.height / 2 - 8, { steps: 4 })
  await page.mouse.move(x, searchRow.y + 2, { steps: 12 })
  await page.mouse.up()
  await expect(rows).toHaveText(['Weather', 'Search', 'Research'])

  // On a phone the list sits in a drawer with no close button, so Escape dismisses it.
  await (mobile
    ? page.keyboard.press('Escape')
    : page.getByRole('button', { name: 'Close reorder', exact: true }).click())
  await expect(pinnedChips(page)).toHaveText(['Weather', 'Search', 'Research'])

  await page.reload()

  await expect(pinnedChips(page)).toHaveText(['Weather', 'Search', 'Research'], { timeout: 30_000 })
  expect(errors).toEqual([])
})
