/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectPageErrors, loginViaEmailCode } from './helpers'
import { expect, test } from './test'
import { defaultModelOpus55 } from '../shared/defaults/models'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test('mobile menus use short transitions and restore keyboard focus after dismissal', async ({ page }) => {
  const errors = collectPageErrors(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await loginViaEmailCode(page)
  const composer = page.locator('textarea')
  await composer.fill('Preserve this draft while navigating.')
  const modelTrigger = page.getByTestId('model-selector-trigger')
  await modelTrigger.focus()
  await page.keyboard.press('Enter')
  const drawer = page.locator('[data-slot="drawer-content"]')
  await expect(drawer).toBeVisible()
  expect(await drawer.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0.2s')
  await expect(
    drawer.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(modelTrigger).toBeFocused()
  await expect(composer).toHaveValue('Preserve this draft while navigating.')

  const sidebarTrigger = page.locator('[data-slot="create-item-layout"] header').first().getByRole('button').first()
  await sidebarTrigger.focus()
  await page.keyboard.press('Enter')
  const sidebar = page.locator('[data-slot="sidebar"][data-mobile="true"]')
  await expect(sidebar).toHaveAttribute('data-open')
  expect(await sidebar.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0.2s')
  await page.keyboard.press('Escape')
  await expect(sidebar).not.toHaveAttribute('data-open')
  await expect(sidebarTrigger).toBeFocused()
  await expect(composer).toBeEditable()
  await expect(composer).toHaveValue('Preserve this draft while navigating.')
  expect(errors).toEqual([])
})
