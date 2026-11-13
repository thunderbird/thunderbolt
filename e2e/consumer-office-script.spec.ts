/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { Document, Packer, Paragraph } from 'docx'
import JSZip from 'jszip'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode, sendChatPrompt } from './helpers'
import {
  officeEditFilename,
  officeEditMarker,
  officeEditPlaceholder,
  officeEditPrompt,
  officeScriptFilename,
  officeScriptMarker,
  officeScriptPrompt,
  officeWorkbookFilename,
  officeWorkbookPrompt,
} from './office-script-fixture'
import { expect, test } from './test'

/**
 * The Excelize file itself. The dev server also answers `excelize.wasm.gz?import&url` with a small module that only
 * names the file's URL, which every Office run loads.
 */
const isExcelizeDownload = (url: string) => {
  const { pathname, searchParams } = new URL(url)
  return /excelize[^/]*\.gz$/.test(pathname) && !searchParams.has('import')
}

const chooseFakeModel = async (page: Page) => {
  await page.getByTestId('model-selector-trigger').click()
  await page.getByRole('button', { name: `${defaultModelOpus55.name} Thunderbolt`, exact: true }).click()
  await page.keyboard.press('Escape')
}

/**
 * The fake provider plays a model that calls `run_office_script`. Everything after that is the real app: the tool,
 * the sandbox Worker loading its WASM and library files from the app, the attachment store, the chip and the
 * download. This is the path happy-dom and Bun cannot run.
 */
test('the agent builds a Word document in the sandbox Worker and the user downloads it', async ({ page }) => {
  const errors = collectPageErrors(page)
  const workerUrls: string[] = []
  page.on('worker', (worker) => workerUrls.push(worker.url()))
  const excelizeRequests: string[] = []
  page.on('request', (request) => isExcelizeDownload(request.url()) && excelizeRequests.push(request.url()))
  await loginViaEmailCode(page)
  await chooseFakeModel(page)

  await sendChatPrompt(page, officeScriptPrompt)

  const download = page.getByRole('button', { name: `Download ${officeScriptFilename}` })
  await expect(download).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  expect(workerUrls.some((url) => url.includes('office-script.worker'))).toBe(true)

  const [file] = await Promise.all([page.waitForEvent('download'), download.click()])
  expect(file.suggestedFilename()).toBe(officeScriptFilename)
  const zip = await JSZip.loadAsync(await readFile(await file.path()))
  expect(await zip.file('word/document.xml')?.async('string')).toContain(officeScriptMarker)
  // A chat that never touches a spreadsheet never downloads Excelize.
  expect(excelizeRequests).toEqual([])

  expect(errors).toEqual([])
})

test('the agent builds a workbook with Excelize and the downloaded file holds the computed total', async ({ page }) => {
  const errors = collectPageErrors(page)
  const excelizeRequests: string[] = []
  page.on('request', (request) => isExcelizeDownload(request.url()) && excelizeRequests.push(request.url()))
  await loginViaEmailCode(page)
  await chooseFakeModel(page)

  await sendChatPrompt(page, officeWorkbookPrompt)

  const download = page.getByRole('button', { name: `Download ${officeWorkbookFilename}` })
  // Excelize is about 4.6 MB, fetched on this first use.
  await expect(download).toBeVisible({ timeout: 60_000 })
  expect(excelizeRequests.length).toBeGreaterThan(0)

  const [file] = await Promise.all([page.waitForEvent('download'), download.click()])
  expect(file.suggestedFilename()).toBe(officeWorkbookFilename)
  const sheet = await (await JSZip.loadAsync(await readFile(await file.path())))
    .file('xl/worksheets/sheet1.xml')
    ?.async('string')
  // The total is stored as a number, so a viewer that does not calculate still shows it.
  expect(sheet).toContain('<c r="B3"><f>SUM(B1:B2)</f><v>1650</v></c>')

  expect(errors).toEqual([])
})

test('the agent edits an attached Word document and the user downloads the edited copy', async ({ page }) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)
  await chooseFakeModel(page)
  const brief = new Document({ sections: [{ children: [new Paragraph(`Status: ${officeEditPlaceholder}`)] }] })
  await page.locator('input[type="file"]').setInputFiles({
    name: officeEditFilename,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await Packer.toBuffer(brief),
  })
  await expect(page.getByText(officeEditFilename, { exact: true })).toBeVisible()

  await sendChatPrompt(page, officeEditPrompt)

  const reply = page.locator('[data-quotable-message-id]').last()
  const download = reply.getByRole('button', { name: `Download ${officeEditFilename}` })
  await expect(download).toBeVisible({ timeout: 30_000 })
  await expect(reply.getByText('Edited', { exact: true })).toBeVisible()
  await expect(reply).toContainText(fakeProviderReply)

  const [file] = await Promise.all([page.waitForEvent('download'), download.click()])
  expect(file.suggestedFilename()).toBe(officeEditFilename)
  const documentXml = await (await JSZip.loadAsync(await readFile(await file.path())))
    .file('word/document.xml')
    ?.async('string')
  expect(documentXml).toContain(officeEditMarker)
  expect(documentXml).not.toContain(officeEditPlaceholder)

  expect(errors).toEqual([])
})
