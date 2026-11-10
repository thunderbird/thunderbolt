/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { loginViaEmailCode } from './helpers'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'

test('debug sharing previews redacted content, requires consent, and cancels without upload', async ({ page }) => {
  await page.route('**/v1/config', async (route) => {
    const response = await route.fetch()
    const config = await response.json()
    await route.fulfill({ response, json: { ...config, debugTranscriptsEnabled: true } })
  })
  const submissions: unknown[] = []
  await page.route('**/v1/debug-transcripts', async (route) => {
    submissions.push(route.request().postDataJSON())
    await route.fulfill({ status: 201, json: { id: 'synthetic-transcript' } })
  })
  await loginViaEmailCode(page)
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: defaultModelOpus55.name, exact: true }).click()
  await page.keyboard.press('Escape')
  const secret = crypto.randomUUID()
  await page.locator('textarea').fill(`Diagnostic context Client Secret: ${secret} AWS Secret Access Key: ${secret}`)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(fakeProviderReply, { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Share debug transcript', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Having a problem with this chat?' })
  const preview = dialog.getByRole('textbox', { name: 'Content to send' })
  await expect(preview).toBeVisible()
  expect((await preview.inputValue()).includes(secret)).toBe(false)
  await expect(dialog.getByRole('button', { name: 'Send to the Thunderbolt team' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Not now' }).click()
  await expect(dialog).toBeHidden()
  expect(submissions).toHaveLength(0)
  await page.getByRole('button', { name: 'Share debug transcript', exact: true }).click()
  const longNote =
    `Ordinary note Client Secret: ${secret} AWS Secret Access Key: ${secret} ` + 'client_secret=x '.repeat(81)
  expect(longNote.length).toBeLessThan(2000)
  await dialog.getByRole('textbox', { name: "Anything else you'd like to share?" }).fill(longNote)
  const reviewed = await preview.inputValue()
  expect(reviewed.includes(secret)).toBe(false)
  expect(reviewed).toContain('Ordinary note')
  expect(JSON.parse(reviewed).userNote.length).toBeLessThanOrEqual(2000)
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Send to the Thunderbolt team' }).click()
  await expect(dialog).toBeHidden()
  expect(submissions).toEqual([JSON.parse(reviewed)])

  await page.getByRole('button', { name: 'Share debug transcript', exact: true }).click()
  const escapedNote =
    'client_secret=x ' +
    'p'.repeat(1959) +
    ' client_secret=' +
    String.fromCharCode(92, 34) +
    'x' +
    String.fromCharCode(92, 34) +
    ' '
  expect(escapedNote.length).toBe(1996)
  await dialog.getByRole('textbox', { name: "Anything else you'd like to share?" }).fill(escapedNote)
  const cappedPreview = await preview.inputValue()
  await expect(dialog.getByRole('button', { name: 'Send to the Thunderbolt team' })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Send to the Thunderbolt team' }).click()
  await expect(dialog).toBeHidden()
  expect(submissions).toEqual([JSON.parse(reviewed), JSON.parse(cappedPreview)])
})
