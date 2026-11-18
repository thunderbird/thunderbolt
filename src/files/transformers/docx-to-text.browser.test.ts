/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { bundleForBrowser } from '@/test-utils/bundle-for-browser'
import { sampleDocx } from '@/test-utils/sample-docx'
import { withZip64Count } from '@/test-utils/zip-fixtures'
import type * as DocxToText from './docx-to-text'
import { docxMime } from '.'

const mib = 1024 * 1024

const sampleText = [
  'Quarterly report',
  'Regions',
  'Revenue grew in every region',
  'Costs stayed flat',
  'Review the forecast',
  'Send it to finance',
  'Region',
  'Revenue',
  'North',
  '1,200',
].join('\n\n')

const asFile = (blob: Blob) => ({
  id: 'file-1',
  filename: 'report.docx',
  mimeType: docxMime,
  size: blob.size,
  createdAt: 0,
  blob,
})

/** The sample document with its parts changed by `edit`, zipped again. */
const editedDocx = async (edit: (parts: Record<string, Uint8Array>) => void) => {
  const parts = unzipSync(new Uint8Array(await (await sampleDocx()).arrayBuffer()))
  edit(parts)
  return zipSync(parts)
}

/** Puts `body` in place of everything in the sample's document body. */
const withBody = (parts: Record<string, Uint8Array>, body: string) => {
  const xml = strFromU8(parts['word/document.xml'])
  parts['word/document.xml'] = strToU8(xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`))
}

describe('docx-to-text in the browser build', () => {
  let docx: typeof DocxToText

  beforeAll(async () => {
    // Under Bun mammoth resolves to its Node build, which cannot read an ArrayBuffer.
    docx = await bundleForBrowser<typeof DocxToText>(join(import.meta.dir, 'docx-to-text.ts'))
  })

  test('gives the model every heading, list item and table cell of an attached document, in reading order', async () => {
    const { text } = await docx.docxToText(asFile(await sampleDocx()))

    expect(text).toBe(sampleText)
  })

  test('reads a document whose pictures unpack past every limit, since its text needs none of them', async () => {
    const zip = await editedDocx((parts) => {
      parts['word/media/zeros.bin'] = new Uint8Array(8 * mib)
    })

    const { text } = await docx.docxToText(asFile(new Blob([zip])))

    expect(text).toBe(sampleText)
  })

  test('refuses a document whose text unpacks to more than 4 MiB', async () => {
    const zip = await editedDocx((parts) => withBody(parts, `<w:p><w:r><w:t>${'a'.repeat(5 * mib)}</w:t></w:r></w:p>`))

    await expect(docx.docxToText(asFile(new Blob([zip])))).rejects.toThrow(
      "This document's text unpacks to over 4 MiB, the limit for reading it.",
    )
  })

  test('refuses a document of empty paragraphs too many for the reader to hold, though it is under 1 MiB', async () => {
    const zip = await editedDocx((parts) => withBody(parts, '<w:p/>'.repeat(110_000)))

    await expect(docx.docxToText(asFile(new Blob([zip])))).rejects.toThrow(
      "Reading this document's text would take over 400 MiB of memory, the limit for reading it.",
    )
  })

  test('counts attributes with elements: 70,000 empty paragraphs alone fit, with 450,000 attributes they do not', async () => {
    const attributes = Array.from({ length: 100 }, (_, index) => `a${index}=""`).join(' ')
    const zip = await editedDocx((parts) =>
      withBody(parts, '<w:p/>'.repeat(70_000) + `<w:p ${attributes}/>`.repeat(4_500)),
    )

    await expect(docx.docxToText(asFile(new Blob([zip])))).rejects.toThrow('would take over 400 MiB of memory')
  })

  test('refuses a zip that claims more parts than a classic zip can list', async () => {
    const zip = withZip64Count(await editedDocx(() => {}), 70_000)

    await expect(docx.docxToText(asFile(new Blob([zip])))).rejects.toThrow('more than 65535 parts')
  })
})
