/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page, Worker } from '@playwright/test'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode, sendChatPrompt } from './helpers'
import { officeWorkbookFilename, officeWorkbookPrompt } from './office-script-fixture'
import { expect, test } from './test'
import { hostileFilename, hostileProbeOrigin, hostileScriptText, hostileWorkbook } from './xlsx-preview-fixture'

/**
 * A request for the Excelize file itself. The dev server also serves a module that only names its URL; that request
 * carries `?import` and does not count.
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

/** The side view: a panel on desktop, a full-screen dialog on a phone. */
const contentView = (page: Page) =>
  (page.viewportSize()?.width ?? 1280) < 768 ? page.getByRole('dialog') : page.getByTestId('content-view')

const previewWorkers = (page: Page) => {
  const workers: Worker[] = []
  page.on('worker', (worker) => worker.url().includes('xlsx-preview.worker') && workers.push(worker))
  return workers
}

/**
 * Runs the real app end to end. The office script tool saves a workbook, its chip opens the side view, and the
 * preview Worker reads it with Excelize into the grid. Closing the panel ends the Worker.
 */
test('a workbook the agent created opens in the side panel as a grid with sheet tabs', async ({ page }) => {
  const errors = collectPageErrors(page)
  const workers = previewWorkers(page)
  await loginViaEmailCode(page)
  await chooseFakeModel(page)

  await sendChatPrompt(page, officeWorkbookPrompt)
  await expect(page.getByRole('button', { name: `Download ${officeWorkbookFilename}` })).toBeVisible({
    timeout: 60_000,
  })
  // The first answer moves the chat to its own URL, and a panel opened before the move would close with it.
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  await page.getByTitle(officeWorkbookFilename, { exact: true }).click()

  const panel = contentView(page)
  const grid = panel.getByRole('grid', { name: 'Sheet1' })
  await expect(grid).toBeVisible({ timeout: 30_000 })
  await expect(grid.getByRole('gridcell', { name: 'Rent' })).toBeVisible()
  await expect(grid.getByRole('gridcell', { name: '1650' })).toBeVisible()
  await expect(panel.getByRole('tab', { name: 'Sheet1' })).toHaveAttribute('aria-selected', 'true')
  expect(workers).toHaveLength(1)

  await grid.focus()
  await page.keyboard.press('ArrowDown')
  await expect(grid).toHaveAttribute('aria-activedescendant', /-1-0$/)

  const closed = workers[0].waitForEvent('close')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await closed
  expect(errors).toEqual([])
})

test('a hostile workbook previews as text, runs no script and sends no request out of the app', async ({ page }) => {
  const errors = collectPageErrors(page)
  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  const excelizeRequests: string[] = []
  // Other origins count only once the preview opens, because the app warms up its model provider at startup.
  const outsideRequests: string[] = []
  const preview = { open: false }
  page.on('request', (request) => {
    const url = request.url()
    if (isExcelizeDownload(url)) {
      excelizeRequests.push(url)
    }
    if (
      url.startsWith(hostileProbeOrigin) ||
      (preview.open && !/^(?:https?:\/\/localhost(?::\d+)?\/|blob:|data:)/.test(url))
    ) {
      outsideRequests.push(url)
    }
  })
  await loginViaEmailCode(page)
  await chooseFakeModel(page)
  await page.locator('input[type="file"]').setInputFiles({
    name: hostileFilename,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await hostileWorkbook(),
  })
  await sendChatPrompt(page, 'What is in this workbook?')
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  // Sending a workbook reads it as text. Only opening its preview downloads Excelize.
  expect(excelizeRequests).toEqual([])

  preview.open = true
  await page.getByTitle(hostileFilename, { exact: true }).click()
  const panel = contentView(page)
  const grid = panel.getByRole('grid', { name: '<img src=x onerror=alert(1)>' })
  await expect(grid).toBeVisible({ timeout: 30_000 })
  await expect(grid.getByText(hostileScriptText, { exact: true })).toBeVisible()
  await expect(grid.getByText('click me', { exact: true })).toBeVisible()
  expect(excelizeRequests.length).toBeGreaterThan(0)

  await grid.getByText('click me', { exact: true }).click()
  expect(await panel.locator('a, [href], script').count()).toBe(0)
  expect(await panel.locator('img').count()).toBe(0)
  expect(await page.evaluate(() => '__xlsxProbe' in window)).toBe(false)
  expect(outsideRequests).toEqual([])
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
})
