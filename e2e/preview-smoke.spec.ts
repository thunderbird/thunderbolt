/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test'
import { collectPageErrors } from './helpers'

test('deployed preview signs in through Keycloak and opens chat', async ({ page, request }) => {
  // Allow three minutes for Fargate warm-up in addition to the normal browser budget.
  test.setTimeout(300_000)
  const errors = collectPageErrors(page)

  await expect
    .poll(
      async () => {
        try {
          const response = await request.get(`${process.env.PREVIEW_API_URL}/v1/health`, {
            timeout: 10_000,
          })
          return response.status()
        } catch (error) {
          // DNS and connection failures can also occur while the preview warms up.
          return String(error)
        }
      },
      { timeout: 180_000, intervals: [5_000] },
    )
    .toBe(200)

  await page.goto('/')
  await page.locator('#username').fill('demo', { timeout: 60_000 })
  await page.locator('#password').fill('demo')
  await page.locator('#kc-login').click()
  await expect(page.locator('textarea')).toBeVisible({ timeout: 60_000 })
  expect(errors).toEqual([])
})
