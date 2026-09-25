/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModels } from '../shared/defaults/models'
import { loginViaOidc, sendChatPrompt } from './helpers'
import { expect, test } from './test'

test.slow()

for (const model of defaultModels) {
  test(`${model.name} streams a non-empty reply`, async ({ page }) => {
    const streams: string[] = []
    await loginViaOidc(page)
    await page.getByTestId('model-selector-trigger').click()
    await page.getByRole('button', { name: model.name, exact: true }).click()

    page.on('response', (response) => {
      if (response.request().method() !== 'POST') return
      const path = new URL(response.url()).pathname
      const headers = response.headers()
      if (
        /\/chat\/v1\/messages$|\/v1\/proxy$/.test(path) &&
        (headers['content-type']?.includes('text/event-stream') ||
          headers['x-proxy-passthrough-content-type']?.includes('text/event-stream'))
      ) {
        streams.push(response.url())
      }
    })

    await sendChatPrompt(page, 'Write one short sentence about the sky.')

    await expect(page.locator('[data-quotable-message-id]').last().locator('.prose')).toHaveText(/\S/, {
      timeout: 90_000,
    })
    expect(streams, `${model.name} should use a streamed provider response`).not.toHaveLength(0)
  })
}
