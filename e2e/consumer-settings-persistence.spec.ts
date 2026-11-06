/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { collectPageErrors, loginViaEmailCode } from './helpers'

// German catalog copy, matching oidc-language-picker.spec.ts.
const de = { language: 'Sprache', localization: 'Lokalisierung', modifiedItem: 'Geändertes Element' }

test.use({ locale: 'en-US' })

/** Wait for the persisted language change, then verify it survives a fresh page load. */
test('a changed setting survives a reload', async ({ page }) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)
  await page.goto('/settings/preferences')

  const language = page.getByTestId('language')
  await expect(language).toBeVisible({ timeout: 30_000 })
  await language.click()
  await page.getByRole('option', { name: 'Deutsch' }).click()
  const modifiedLanguage = page.locator(`label[aria-label="${de.modifiedItem}"]`).filter({ hasText: de.language })
  await expect(page.getByText(de.localization)).toBeVisible()
  await expect(modifiedLanguage).toBeVisible()

  await page.reload()

  await expect(page.getByText(de.localization)).toBeVisible({ timeout: 30_000 })
  await expect(language).toHaveText('Deutsch')
  await expect(modifiedLanguage).toBeVisible()
  expect(errors).toEqual([])
})
