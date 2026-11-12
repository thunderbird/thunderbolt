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

test('the floating header keeps an opaque app surface and a gradient without backdrop blur', async ({ page }) => {
  await loginViaEmailCode(page)
  // Exercise the transparent-root styling used by macOS's native glass sidebar.
  await page.evaluate(() => document.documentElement.classList.add('mac-vibrancy'))
  const scrim = page.locator('[data-slot="app-header-scrim"]')
  for (const route of ['chat', 'settings']) {
    if (route === 'settings') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Models', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible()
    }
    for (const dark of [false, true]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
      await expect(scrim).toHaveCSS('backdrop-filter', 'none')
      await expect(scrim).toHaveCSS('background-image', /linear-gradient/)
      await expect(scrim).toHaveCSS('mask-image', /linear-gradient/)
      const surface = page.locator('main').filter({ has: scrim })
      await expect(surface).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const coversHeader = await scrim.evaluate((element) => {
        const header = element.getBoundingClientRect()
        const pane = element.closest('main')!.getBoundingClientRect()
        return (
          pane.top <= header.top &&
          pane.bottom >= header.bottom &&
          pane.left <= header.left &&
          pane.right >= header.right
        )
      })
      expect(coversHeader).toBe(true)
    }
  }
})
