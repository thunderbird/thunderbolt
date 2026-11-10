/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test'

/** Populate the real database through the supported backup UI and wait for its transaction to finish. */
export const importBackup = async (page: Page, backup: Record<string, unknown>, timeout = 60_000) => {
  await page.goto('/settings/preferences')
  await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
    name: 'fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await page
    .getByRole('alertdialog', { name: 'Import this backup?' })
    .getByRole('button', { name: 'Import', exact: true })
    .click()
  await expect(page.locator('#import-data-success')).toBeVisible({ timeout })
}
