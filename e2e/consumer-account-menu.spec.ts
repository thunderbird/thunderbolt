/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { collectPageErrors, loginViaEmailCode, openSidebarOnMobile } from './helpers'
import { expect, test } from './test'

for (const viewport of [
  { width: 320, height: 480 },
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  test.describe(`account menu at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width < 768 })

    test('uses the responsive surface and supports nested account actions', async ({ page }) => {
      const errors = collectPageErrors(page)
      const email = await loginViaEmailCode(page)
      await openSidebarOnMobile(page)
      const trigger = page.getByRole('button', { name: 'Account menu' })
      await page.keyboard.press('Tab')
      await trigger.focus()
      await expect
        .poll(() => trigger.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth)))
        .toBeGreaterThan(0)
      await expect(trigger).not.toHaveCSS('outline-style', 'none')
      await page.keyboard.press('Enter')

      const menu = page.getByRole('dialog', { name: 'Account menu', exact: true })
      await expect(menu).toBeVisible()
      await expect(menu.getByText(email, { exact: true })).toBeVisible()
      const syncToggle = menu.getByRole('switch', { name: 'Enable cloud sync' })
      await expect(syncToggle).toBeEnabled()
      await expect(syncToggle).not.toBeChecked()

      if (viewport.width < 768) {
        await expect(menu).toHaveAttribute('data-slot', 'drawer-content')
        await expect(menu).toHaveAttribute('data-swipe-direction', 'down')
        const backdrop = menu.locator('..').locator('xpath=preceding-sibling::*[@data-slot="drawer-overlay"]')
        await expect(backdrop).toBeVisible()
        await expect
          .poll(() => backdrop.evaluate((element) => getComputedStyle(element).backdropFilter))
          .toContain('blur(')
        const backdropBounds = await backdrop.boundingBox()
        expect(backdropBounds!.x).toBe(0)
        expect(backdropBounds!.y).toBe(0)
        expect(backdropBounds!.width).toBe(viewport.width)
        expect(backdropBounds!.height).toBeGreaterThanOrEqual(viewport.height)
        await expect(menu.locator('[data-slot="drawer-handle"]')).toBeVisible()
        await expect
          .poll(async () => {
            const bounds = await menu.boundingBox()
            return bounds && Math.abs(bounds.y + bounds.height - viewport.height)
          })
          .toBeLessThanOrEqual(1)
        const bounds = await menu.boundingBox()
        expect(bounds!.x).toBe(0)
        expect(bounds!.width).toBe(viewport.width)
        expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        for (const row of await menu.getByRole('link').all()) {
          expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        }
        expect(
          (await menu.getByRole('button', { name: 'Log out', exact: true }).boundingBox())!.height,
        ).toBeGreaterThanOrEqual(44)
      } else {
        await expect(menu).toHaveAttribute('data-slot', 'popover-content')
        expect((await menu.boundingBox())!.width).toBeLessThan(viewport.width / 2)
      }

      await syncToggle.click()
      const setup = page.getByRole('dialog', { name: 'Set up encrypted sync', exact: true })
      await expect(setup).toBeVisible()
      await expect(menu).toBeHidden()
      await expect(setup.getByRole('button', { name: 'Continue', exact: true })).toBeFocused()
      await setup.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(setup).toBeHidden()
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(menu).toBeVisible()
      await expect(syncToggle).not.toBeChecked()

      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
      if (viewport.width < 768) {
        await expect(page.locator('[data-slot="sidebar"][data-mobile="true"]')).toHaveAttribute('data-open')
      }

      await trigger.click()
      await menu.getByRole('button', { name: 'Log out', exact: true }).click()
      await expect(menu).toBeHidden()
      const confirmation = page.getByRole('dialog', { name: 'Log out', exact: true })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(confirmation).toBeHidden()
      await expect(trigger).toBeFocused()

      await trigger.click()
      await menu.getByRole('link', { name: 'Dev Settings', exact: true }).click()
      await expect(page).toHaveURL(/\/settings\/dev-settings$/)
      await expect(menu).toBeHidden()
      if (viewport.width < 768) {
        await expect(page.locator('[data-slot="sidebar"][data-mobile="true"]')).not.toHaveAttribute('data-open')
      }
      expect(errors).toEqual([])
    })
  })
}
