/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { collectPageErrors, loginViaEmailCode } from './helpers'

/** Exercise email entry and code verification through the authenticated chat landing. */
test('anonymous user signs in with the code sent by email and lands on the chat', async ({ page }) => {
  const errors = collectPageErrors(page)

  await loginViaEmailCode(page)

  await expect(page).toHaveURL(/\/chats\//)
  await expect(page.locator('textarea')).toBeVisible()
  expect(errors).toEqual([])
})
