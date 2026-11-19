/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Locator, Page } from '@playwright/test'

/** Match the visible model name across builds with or without accessible provider logos. */
export const modelOption = (page: Page, name: string) =>
  page.getByRole('button').filter({ has: page.getByText(name, { exact: true }) })

/** Resolve actionability outside recording; the measured action still dispatches real pointer input. */
export const clickAction = async (page: Page, locator: Locator) => {
  await locator.click({ trial: true })
  const box = await locator.boundingBox()
  if (!box) {
    throw new Error('The interaction target has no bounds')
  }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  return () => (page.viewportSize()!.width < 768 ? page.touchscreen.tap(x, y) : page.mouse.click(x, y))
}
