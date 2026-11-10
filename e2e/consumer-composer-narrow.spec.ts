/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelDeepSeekV41Flash } from '../shared/defaults/models'
import { loginViaEmailCode } from './helpers'
import { expect, test } from './test'

// Narrow enough that a non-shrinking model button overlaps the send button.
test.use({ viewport: { width: 300, height: 700 } })

test('a narrow composer truncates the model name instead of overflowing the send button', async ({ page }) => {
  await loginViaEmailCode(page)
  await page.locator('textarea').fill('Hello')

  const trigger = page.getByTestId('model-selector-trigger')
  const name = trigger.getByText(defaultModelDeepSeekV41Flash.name, { exact: true })
  await expect(name).toBeVisible()
  const triggerBox = (await trigger.boundingBox())!
  const sendBox = (await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox())!
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(sendBox.x)
  expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
})
