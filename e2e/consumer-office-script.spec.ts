/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { DOMParser } from '@xmldom/xmldom'
import { Document, Packer, Paragraph } from 'docx'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { z } from 'zod'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { fakeProviderReply } from './fake-provider'
import { collectPageErrors, loginViaEmailCode, sendChatPrompt } from './helpers'
import { importBackup } from './import-backup'
import { contentView } from './office-preview'
import {
  officeDeckEditFilename,
  officeDeckEditMarker,
  officeDeckEditPrompt,
  officeEditFilename,
  officeEditMarker,
  officeEditPlaceholder,
  officeEditPrompt,
  officeRetryFind,
  officeRetryPrompt,
  officeRetryScript,
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

/** Opens the reply's only step, the Office run, and returns the panes that show its call's input and result. */
const openOfficeStep = async (page: Page) => {
  const group = page.locator('[data-quotable-message-id]').last().locator('.tool-invocation-card')
  await expect(group).toHaveCount(1)
  await group.getByText(/Completed 1 step/).click()
  await group.getByText('Run Office Script').click()
  return { input: page.getByTestId('object-view-input'), output: page.getByTestId('object-view-output') }
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

test('a run that created a file stays a step that shows its script and result, after the turn and after a reload', async ({
  page,
}) => {
  const expectStepBesideChip = async () => {
    const reply = page.locator('[data-quotable-message-id]').last()
    await expect(reply.getByRole('button', { name: `Download ${officeScriptFilename}` })).toBeVisible({
      timeout: 30_000,
    })
    const step = await openOfficeStep(page)
    await expect(step.input).toContainText('saveFile')
    await expect(step.input).toContainText(officeScriptFilename)
    await expect(step.output).toContainText(officeScriptFilename)
  }
  await loginViaEmailCode(page)
  await chooseFakeModel(page)
  await sendChatPrompt(page, officeScriptPrompt)

  await expectStepBesideChip()
  // Reload once the turn is over, so the reply is saved whole.
  await expect(page.locator('[data-quotable-message-id]').last()).toContainText(fakeProviderReply)
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  await page.reload()
  await expectStepBesideChip()
})

test('a failed Office step and its edit survive reload with one downloadable document', async ({ page }) => {
  await loginViaEmailCode(page)
  await chooseFakeModel(page)
  await sendChatPrompt(page, officeRetryPrompt)
  const reply = page.locator('[data-quotable-message-id]').last()
  const download = reply.getByRole('button', { name: `Download ${officeScriptFilename}` })
  await expect(download).toBeVisible({ timeout: 30_000 })
  await expect(reply).toContainText(fakeProviderReply)
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)

  const inspect = async () => {
    await expect(download).toHaveCount(1)
    await expect(reply.getByRole('button', { name: /earlier version/ })).toHaveCount(0)
    await reply.getByText(/Completed 2 steps/).click()
    const steps = reply.getByText('Run Office Script', { exact: true })
    await expect(steps).toHaveCount(2)
    const input = page.getByTestId('object-view-input')
    const output = page.getByTestId('object-view-output')
    await steps.first().click()
    expect(JSON.parse(await input.innerText())).toEqual({ script: officeRetryScript })
    const failure = z.object({ ok: z.literal(false), scriptId: z.string() })
    const { scriptId } = z
      .union([failure, z.object({ details: failure }).transform((r) => r.details)])
      .parse(JSON.parse(await output.innerText()))
    await contentView(page).getByRole('button', { name: 'Close', exact: true }).click()
    await steps.last().click()
    expect(JSON.parse(await input.innerText())).toEqual({
      edit: { scriptId, replacements: [{ find: officeRetryFind, replace: '' }] },
    })
    await expect(output).toContainText(officeScriptFilename)
    return scriptId
  }
  const id = await inspect()
  await page.reload()
  expect(await inspect()).toBe(id)
  const storedCount = await page.evaluate(async () => {
    const modulePath = '/src/lib/local-data-owner.ts'
    const { attachmentDatabaseName } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('../src/lib/local-data-owner')
    return new Promise<number>((resolve, reject) => {
      const open = indexedDB.open(attachmentDatabaseName())
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const count = db.transaction('attachments').objectStore('attachments').count()
        count.onsuccess = () => resolve(count.result)
        count.onerror = () => reject(count.error)
        db.close()
      }
    })
  })
  expect(storedCount).toBe(1)
  await contentView(page).getByRole('button', { name: 'Close', exact: true }).click()
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()])
  const zip = await JSZip.loadAsync(await readFile(await file.path()))
  expect(await zip.file('word/document.xml')?.async('string')).toContain(officeScriptMarker)
})

test('a saved reply folds three same-name files and restores their chips after reload', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  const email = await loginViaEmailCode(page)
  const chatId = crypto.randomUUID()
  const filename = 'deck.pptx'
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'office-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'Deck revisions' }],
      chat_messages: [
        {
          id: crypto.randomUUID(),
          chatThreadId: chatId,
          parentId: null,
          role: 'assistant',
          modelId: defaultModelOpus55.id,
          content: '',
          parts: [
            { type: 'text', text: 'Saving the deck.' },
            ...[false, false, true].map((edited) => ({
              type: 'tool-run_office_script',
              toolCallId: crypto.randomUUID(),
              state: 'output-available',
              input: {},
              output: {
                ok: true,
                files: [
                  {
                    id: crypto.randomUUID(),
                    filename,
                    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    edited,
                  },
                ],
                logs: '',
              },
            })),
          ],
        },
      ],
    },
  })
  await page.goto(`/chats/${chatId}`)
  const reply = page.locator('[data-quotable-message-id]').last()
  const chips = reply.getByText(filename, { exact: true })
  const versions = reply.getByRole('button', { name: '2 earlier versions' })
  const checkVersions = async () => {
    await expect(chips).toHaveCount(1)
    await expect(reply.getByText('Edited', { exact: true })).toBeVisible()
    const groups = reply.getByRole('button', { name: /Completed 1 step in/ })
    await expect(groups).toHaveCount(3)
    const step = groups.last()
    await step.click()
    await expect(step).toBeFocused()
    await expect(step).toHaveAttribute('aria-expanded', 'true')
    await expect(versions).toHaveAttribute('aria-expanded', 'false')
    await expect(reply.getByRole('button', { name: 'Copy message' })).toBeVisible()
    // Click the chevron, where the message actions previously covered the disclosure.
    await versions.locator('svg').click({ timeout: 5000 })
    await expect(versions).toHaveAttribute('aria-expanded', 'true')
    await expect(step).toHaveAttribute('aria-expanded', 'true')
    await expect(chips).toHaveCount(3)
    await expect(reply.getByText('Not available on this device')).toHaveCount(3)
  }
  await checkVersions()
  await page.reload()
  await checkVersions()
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

  // The card the user attached, the first with this name, still opens the original.
  await page.locator(`button[title="${officeEditFilename}"]`).first().click()
  const original = contentView(page).frameLocator(`iframe[title="${officeEditFilename}"]`)
  await expect(original.getByText(`Status: ${officeEditPlaceholder}`)).toBeVisible()

  // The run's step names the attachment it read.
  await contentView(page).getByRole('button', { name: 'Close', exact: true }).click()
  const step = await openOfficeStep(page)
  await expect(step.input).toContainText('"inputs"')
  await expect(step.input).toContainText(officeEditFilename)

  expect(errors).toEqual([])
})

test('the agent edits an attached deck, and the edited copy opens in the side panel', async ({ page }) => {
  const errors = collectPageErrors(page)
  await loginViaEmailCode(page)
  await chooseFakeModel(page)
  const deck = new PptxGenJS()
  deck.addSlide().addText(`Status: ${officeEditPlaceholder}`, { objectName: 'Status', x: 0.5, y: 0.5, w: 9, h: 1 })
  await page.locator('input[type="file"]').setInputFiles({
    name: officeDeckEditFilename,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: Buffer.from((await deck.write({ outputType: 'uint8array' })) as Uint8Array),
  })
  await expect(page.getByText(officeDeckEditFilename, { exact: true })).toBeVisible()

  await sendChatPrompt(page, officeDeckEditPrompt)

  const reply = page.locator('[data-quotable-message-id]').last()
  await expect(reply.getByRole('button', { name: `Download ${officeDeckEditFilename}` })).toBeVisible({
    timeout: 30_000,
  })
  await expect(reply.getByText('Edited', { exact: true })).toBeVisible()

  const download = page.waitForEvent('download')
  await reply.getByRole('button', { name: `Download ${officeDeckEditFilename}` }).click()
  const zip = await JSZip.loadAsync(await readFile(await (await download).path()))
  const xml = new DOMParser().parseFromString(
    await zip.file('ppt/slides/slide1.xml')!.async('string'),
    'application/xml',
  )
  const status = Array.from(xml.getElementsByTagName('p:cNvPr')).find((el) => el.getAttribute('name') === 'Status')
  expect(status).toBeDefined()
  expect(xml.getElementsByTagName('p:spTgt')[0].getAttribute('spid')).toBe(status!.getAttribute('id'))
  expect(xml.getElementsByTagName('p:animEffect')[0].getAttribute('filter')).toBe('fade')
  expect(xml.getElementsByTagName('p:transition')[0].children[0].localName).toBe('fade')

  await reply.locator(`button[title="${officeDeckEditFilename}"]`).click()
  const slides = contentView(page).frameLocator(`iframe[title="${officeDeckEditFilename}"]`)
  await expect(slides.getByText(`Status: ${officeDeckEditMarker}`)).toBeVisible()

  await contentView(page).getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator(`button[title="${officeDeckEditFilename}"]`).first().click()
  const original = contentView(page).frameLocator(`iframe[title="${officeDeckEditFilename}"]`)
  await expect(original.getByText(`Status: ${officeEditPlaceholder}`)).toBeVisible()

  expect(errors).toEqual([])
})
