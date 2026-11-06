/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Replayed alongside the repro specs by `.github/qa/scripts/verify.ts replay`, and it must pass every run: if it
// fails, the stack is broken and every repro failure proves nothing. It sits three levels deep like the repro specs
// so it uses the same helpers import and passes the same spec lint.
import { expect, test } from '@playwright/test'
import { loginViaEmailCode } from '../../../e2e/helpers'

test('a fresh user signs in and sees the composer', async ({ page }) => {
  await loginViaEmailCode(page)
  await expect(page.locator('textarea')).toBeVisible()
})
