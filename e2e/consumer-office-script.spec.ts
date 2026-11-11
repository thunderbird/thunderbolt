/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode } from './helpers'
import { officeScriptFilename, officeScriptMarker, officeScriptPrompt } from './office-script-fixture'
import { expect, test } from './test'

/**
 * The fake provider plays a model that calls `run_office_script`. Everything after that is the real app: the tool,
 * the sandbox Worker loading its WASM and library files from the app, the attachment store, the chip and the
 * download. This is the path happy-dom and Bun cannot run.
 */
test('the agent builds a Word document in the sandbox Worker and the user downloads it', async ({ page }) => {
  const errors = collectPageErrors(page)
  const workerUrls: string[] = []
  page.on('worker', (worker) => workerUrls.push(worker.url()))
  await loginViaEmailCode(page)
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')

  await page.getByRole('textbox', { name: 'Ask me anything…' }).fill(officeScriptPrompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  const download = page.getByRole('button', { name: `Download ${officeScriptFilename}` })
  await expect(download).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Created', { exact: true })).toBeVisible()
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  expect(workerUrls.some((url) => url.includes('office-script.worker'))).toBe(true)

  const [file] = await Promise.all([page.waitForEvent('download'), download.click()])
  expect(file.suggestedFilename()).toBe(officeScriptFilename)
  const zip = await JSZip.loadAsync(await readFile(await file.path()))
  expect(await zip.file('word/document.xml')?.async('string')).toContain(officeScriptMarker)

  expect(errors).toEqual([])
})
