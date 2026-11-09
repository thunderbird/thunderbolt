/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { loginViaEmailCode } from './helpers'
import { expect, test } from './test'

test.use({ viewport: { width: 1280, height: 900 } })

test('the project icon matches the agent selector hover background in both themes', async ({ page }) => {
  await loginViaEmailCode(page)
  const agent = page.getByTestId('agent-selector-pill')
  const project = page.locator('[title="Choose project"]')
  for (const dark of [false, true]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
    await agent.hover()
    await agent.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    const background = await agent.evaluate((element) => getComputedStyle(element).backgroundColor)
    await project.hover()
    await expect.poll(() => project.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(background)
  }
})
