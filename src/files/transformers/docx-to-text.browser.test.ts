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

  test('refuses a namespace longer than Word writes, which the reader would copy into every element name', async () => {
    const declared = (length: number) =>
      editedDocx((parts) =>
        withBody(parts, `<w:p xmlns:x="urn:${'a'.repeat(length - 4)}">${'<x:e/>'.repeat(400)}</w:p>`),
      )

    await expect(docx.docxToText(asFile(new Blob([await declared(256)])))).resolves.toEqual({ text: '' })
    await expect(docx.docxToText(asFile(new Blob([await declared(64 * 1024)])))).rejects.toThrow(
      'This document declares a namespace longer than 256 characters, over the limit for reading it.',
    )
  })

  test('refuses over 1,000 different elements to warn about, since comparing the warnings grows with their square', async () => {
    const byName = await editedDocx((parts) =>
      withBody(parts, Array.from({ length: 1_001 }, (_, index) => `<e${index}/>`).join('')),
    )
    const byNamespace = await editedDocx((parts) =>
      withBody(
        parts,
        Array.from({ length: 1_001 }, (_, index) => `<p${index}:br xmlns:p${index}="urn:${index}"/>`).join(''),
      ),
    )

    for (const zip of [byName, byNamespace]) {
      await expect(docx.docxToText(asFile(new Blob([zip])))).rejects.toThrow(
        'This document has over 1000 different kinds of markup, the limit for reading it.',
      )
    }
  })

  test('counts the break types, symbols and styles the reader quotes in its warnings, not only element names', async () => {
    const quoted = (index: number) =>
      `<w:br w:type="t${index}"/><w:sym w:font="f${index}" w:char="41"/><w:p><w:pPr><w:pStyle w:val="s${index}"/></w:pPr></w:p>`
    const zip = await editedDocx((parts) =>
      withBody(parts, Array.from({ length: 400 }, (_, index) => quoted(index)).join('')),
    )

    await expect(docx.docxToText(asFile(new Blob([zip])))).rejects.toThrow('over 1000 different kinds of markup')
  })

  test('refuses a prefix given two namespaces in one part, which would let one written name stand for many', async () => {
    const zip = await editedDocx((parts) =>
      withBody(parts, '<w:p xmlns:x="urn:a"><x:e/></w:p><w:p xmlns:x="urn:b"><x:e/></w:p>'),
    )

    await expect(docx.docxToText(asFile(new Blob([zip])))).rejects.toThrow(
      'This document gives one namespace prefix two different namespaces, so it cannot be read.',
    )
  })

  test('scans a broken tag with a long run and no value in one pass, so it cannot freeze the chat', async () => {
    // Retrying at every character took about 4 s for 80 KB, and grows with the square of the length.
    const zip = await editedDocx((parts) => withBody(parts, `<w:p xmlns ${'a'.repeat(200_000)}/>`))

    const started = performance.now()
    await Promise.allSettled([docx.docxToText(asFile(new Blob([zip])))])

    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test('reads a main document stored under another name, found through its relationship as the reader finds it', async () => {
    const zip = await editedDocx((parts) => {
      const rename = (from: string, to: string) => {
        parts[to] = parts[from]
        delete parts[from]
      }
      rename('word/document.xml', 'word/document.dat')
      rename('word/_rels/document.xml.rels', 'word/_rels/document.dat.rels')
      for (const path of ['_rels/.rels', '[Content_Types].xml']) {
        parts[path] = strToU8(strFromU8(parts[path]).replace('word/document.xml', 'word/document.dat'))
      }
    })

    const { text } = await docx.docxToText(asFile(new Blob([zip])))

    expect(text).toBe(sampleText)
  })

  test('reads a document whose large custom XML part counts toward no limit, since the reader never opens it', async () => {
    const zip = await editedDocx((parts) => {
      parts['customXml/item1.xml'] = strToU8(`<data>${'<v>1</v>'.repeat((5 * mib) / 8)}</data>`)
    })

    const { text } = await docx.docxToText(asFile(new Blob([zip])))

    expect(text).toBe(sampleText)
  })

  test('counts a part once for each role the reader reads it in: 40,000 empty paragraphs fit once, not six times', async () => {
    const roles = ['styles', 'numbering', 'footnotes', 'endnotes', 'comments']
    const relationships = roles.map(
      (role, index) =>
        `<Relationship Id="r${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${role}" Target="document.xml"/>`,
    )
    const once = await editedDocx((parts) => withBody(parts, '<w:p/>'.repeat(40_000)))
    const sixTimes = await editedDocx((parts) => {
      withBody(parts, '<w:p/>'.repeat(40_000))
      parts['word/_rels/document.xml.rels'] = strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`,
      )
    })

    await expect(docx.docxToText(asFile(new Blob([once])))).resolves.toEqual({ text: '' })
    await expect(docx.docxToText(asFile(new Blob([sixTimes])))).rejects.toThrow('would take over 400 MiB of memory')
  })
})
