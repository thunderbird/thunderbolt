/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelOpus5 } from '../shared/defaults/models'
import { loginViaOidc, sendChatPrompt } from './helpers'
import { expect, test } from './test'

test.slow()

test('a file and image remain in the thread and receive a reply', async ({ page }) => {
  await loginViaOidc(page)
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus5.name, exact: true }).click()
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'nightly-note.txt', mimeType: 'text/plain', buffer: Buffer.from('The note says blue heron.') },
    {
      name: 'nightly-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uS8AAAAASUVORK5CYII=',
        'base64',
      ),
    },
  ])
  await expect(page.getByText('nightly-note.txt')).toBeVisible()
  await expect(page.getByText('nightly-image.png')).toBeVisible()
  await sendChatPrompt(page, 'Read the attached note and describe the image in one sentence.')

  await expect(page.locator('[data-quotable-message-id]').last().locator('.prose')).toHaveText(/\S/, {
    timeout: 90_000,
  })
  await expect(page.getByTitle('nightly-note.txt')).toBeVisible()
  await expect(page.getByTitle('nightly-image.png')).toBeVisible()
})
