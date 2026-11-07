/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { importBackup } from './import-backup'
import { PDFDocument } from 'pdf-lib'
import { defaultModelOpus55 } from '../shared/defaults/models'
import { collectPageErrors, loginViaEmailCode, openSidebarOnMobile } from './helpers'
import { expect, test } from './test'

test('PDF history previews wait for visibility, retain their size, and open normally', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = collectPageErrors(page)
  const email = await loginViaEmailCode(page)
  const pdf = await PDFDocument.create()
  pdf.addPage([500, 650]).drawText('PDF thumbnail regression', { x: 30, y: 580, size: 18 })
  await page.goto('/chats/new')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'preview.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  })
  await expect(page.getByText('preview.pdf', { exact: true })).toBeVisible()
  // Read the ID of the attachment uploaded through the UI so the backup references a real local blob.
  const localFileId = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('thunderbolt-files')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const read = database.transaction('attachments').objectStore('attachments').getAll()
          read.onsuccess = () => {
            database.close()
            resolve(read.result[0].id)
          }
          read.onerror = () => {
            database.close()
            reject(read.error)
          }
        }
      }),
  )
  const chatId = crypto.randomUUID()
  const messagePrefix = crypto.randomUUID().slice(0, 24)
  const messageId = (index: number) => `${messagePrefix}${index.toString().padStart(12, '0')}`
  const fixture = {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'pdf-fixture', email },
    tables: {
      chat_threads: [{ id: chatId, title: 'PDF preview history' }],
      chat_messages: Array.from({ length: 80 }, (_, index) => {
        const text = `History message ${index + 1}. ${'Keep this conversation responsive. '.repeat(12)}`
        return {
          id: messageId(index),
          chatThreadId: chatId,
          parentId: index === 0 ? null : messageId(index - 1),
          role: index % 2 === 0 ? 'user' : 'assistant',
          modelId: defaultModelOpus55.id,
          content: text,
          parts: [
            { type: 'text', text },
            ...(index === 20 || index === 40
              ? [
                  {
                    type: 'data-attachment',
                    data: { localFileId, filename: `history-${index}.pdf`, mimeType: 'application/pdf' },
                  },
                ]
              : []),
          ],
        }
      }),
    },
  }
  await importBackup(page, fixture)
  await page.goto('/chats/new')
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: 'PDF preview history', exact: true }).click()
  await expect(page.locator('[data-message-id]').last()).toBeAttached()
  const card = page.getByTitle('history-20.pdf', { exact: true })
  await expect(card).not.toBeInViewport()
  const before = (await card.boundingBox())!
  await page.waitForTimeout(500)
  await expect(page.locator('.react-pdf__Document')).toHaveCount(0)

  await card.scrollIntoViewIfNeeded()
  await expect(card.locator('.react-pdf__Page canvas')).toBeVisible()
  const after = (await card.boundingBox())!
  expect(after.width).toBe(before.width)
  expect(after.height).toBe(before.height)
  await expect(page.getByTitle('history-40.pdf', { exact: true }).locator('.react-pdf__Document')).toHaveCount(0)

  await card.click()
  const preview =
    (page.viewportSize()?.width ?? 1280) < 768 ? page.getByRole('dialog') : page.getByTestId('content-view')
  await expect(preview.getByText('history-20.pdf', { exact: true })).toBeVisible()
  await expect(preview.locator('.react-pdf__Page canvas')).toBeVisible()
  await preview.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(preview).toBeHidden()
  await expect(card.locator('.react-pdf__Page canvas')).toBeVisible()
  await page.locator('[data-message-id]').last().scrollIntoViewIfNeeded()
  await expect(card).not.toBeInViewport()
  await expect(card.locator('.react-pdf__Page canvas')).toHaveCount(1)
  expect(errors).toEqual([])
})
