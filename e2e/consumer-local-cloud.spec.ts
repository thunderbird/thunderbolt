/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { openSidebarOnMobile } from './helpers'
import { expect, test } from './test'

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`local Cloud sign-in at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width < 768 })

    test('connects from the local chat and leaves sync optional', async ({ page }) => {
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      // Match a fresh consumer native install without bypassing server selection or sign-in.
      await page.addInitScript(() => {
        localStorage.setItem(
          'thunderbolt-local-settings',
          JSON.stringify({ state: { cloudUrl: '', localMode: true, serverHasAuthenticated: false }, version: 1 }),
        )
      })
      await page.goto('/chats/new')
      await expect(page.getByRole('heading', { name: 'Connect your AI', exact: true })).toBeVisible()
      await openSidebarOnMobile(page)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.getByRole('radio', { name: 'Cloud (Waitlist)', exact: true }).check()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByPlaceholder('Email', { exact: true }).fill(`local-cloud-${crypto.randomUUID()}@thunderbolt.test`)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.locator('input[autocomplete="one-time-code"]').fill('12345678')

      const syncSetup = page.getByRole('dialog', { name: 'Set up encrypted sync', exact: true })
      await expect(syncSetup).toBeVisible()
      await syncSetup.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(syncSetup).toBeHidden()
      await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible()
      if (viewport.width < 768) {
        await page.mouse.click(viewport.width * 0.95, viewport.height / 2)
        await expect(page.locator('[data-slot="sidebar"][data-mobile="true"]')).not.toHaveAttribute('data-open')
      }
      await expect(page.locator('textarea')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Connect your AI', exact: true })).toHaveCount(0)
      expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem('thunderbolt-local-settings')!).state.syncEnabled),
      ).not.toBe(true)
      expect(pageErrors).toEqual([])
    })
  })
}
