/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { expect, test } from './test'

test('Markdown images stay inert in chat and attachment previews while local images and links work', async ({
  page,
}) => {
  const errors = collectPageErrors(page)
  const requests: string[] = []
  await page.route(/^https?:\/\/markdown-image\.invalid\//, async (route) => {
    requests.push(route.request().url())
    await route.abort()
  })
  await loginViaEmailCode(page)
  const markdown =
    '![Inline description](https://markdown-image.invalid/pixel?secret=synthetic)\n\n' +
    '![Reference description][pixel]\n\n[pixel]: //markdown-image.invalid/reference\n\n' +
    '[Ordinary control](https://markdown-image.invalid/link)'
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'inert-images.md', mimeType: 'text/markdown', buffer: Buffer.from(`# Safe preview\n\n${markdown}`) },
    {
      name: 'local-control.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgYPhPIhrVMKph2GoAAJLb/wFh5Z4RAAAAAElFTkSuQmCC',
        'base64',
      ),
    },
  ])
  const thumbnail = page.getByRole('heading', { name: 'Safe preview' }).locator('..')
  await expect(thumbnail.getByRole('heading', { name: 'Safe preview' })).toBeAttached()
  await expect(thumbnail).toContainText('Reference description')
  await expect(thumbnail.locator('img')).toHaveCount(0)
  const localImage = page.getByRole('img', { name: 'local-control.png', exact: true })
  await expect(localImage).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => localImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')
  await page.locator('textarea').fill(markdown)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply, { timeout: 30_000 })
  const message = page.locator('[data-message-id]').filter({ hasText: 'Inline description' }).first()
  await expect(message.locator('.prose').first().locator('img')).toHaveCount(0)
  const link = message.getByRole('link', { name: 'Ordinary control', exact: true }).last()
  await expect(link).toHaveAttribute('href', 'https://markdown-image.invalid/link')
  await link.click()
  await expect(page.getByRole('alertdialog', { name: 'Open External Link' })).toContainText(
    'https://markdown-image.invalid/link',
  )
  expect(requests).toEqual([])
  expect(errors).toEqual([])
})
