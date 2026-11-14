/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import type { StoredFile } from '@/lib/file-blob-storage'
import { bundleForBrowser } from '@/test-utils/bundle-for-browser'
import { centralSignature, overlappingStoredEntries, withZip64Count } from '@/test-utils/zip-fixtures'
import type * as XlsxToText from './xlsx-to-text'

const mib = 1024 * 1024

/** `A` for column 0, `AX` for column 49. */
const columnName = (index: number): string =>
  `${index < 26 ? '' : columnName(Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`

/** A one-sheet workbook of inline strings, deflated as Excel saves it. An empty row is left out, as Excel leaves it. */
const workbook = (rows: string[][]) => {
  const sheetData = rows
    .map((cells, row) =>
      cells.length === 0
        ? ''
        : `<row r="${row + 1}">${cells
            .map((text, column) => `<c r="${columnName(column)}${row + 1}" t="inlineStr"><is><t>${text}</t></is></c>`)
            .join('')}</row>`,
    )
    .join('')
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
    ),
  })
}

/** Rewrites what the central directory says about the zip's last entry: its unpacked size and compression method. */
const relabelLastEntry = (zip: Uint8Array<ArrayBuffer>, size: number, method: number) => {
  const central = Buffer.from(zip).lastIndexOf(centralSignature)
  const view = new DataView(zip.buffer)
  view.setUint16(central + 10, method, true)
  view.setUint32(central + 24, size, true)
  return zip
}

/** Renames an entry in its local header and its central directory record. `to` must be as long as `from`. */
const renameEntry = (zip: Uint8Array<ArrayBuffer>, from: string, to: string) => {
  const bytes = Buffer.from(zip.buffer)
  bytes.write(to, bytes.indexOf(from))
  bytes.write(to, bytes.indexOf(from))
  return zip
}

const asFile = (bytes: Uint8Array<ArrayBuffer>): StoredFile => ({
  id: 'file-1',
  filename: 'book.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: bytes.byteLength,
  createdAt: 0,
  blob: new Blob([bytes]),
})

/** Stands in for the CSP: every Worker is recorded and never answers, so a read that needs one never returns. */
class BlockedWorker {
  static started = 0
  constructor() {
    BlockedWorker.started++
  }
  postMessage() {}
  terminate() {}
}

/** Settles with `promise`, or rejects with the number of Workers started if it has not settled after `ms`. */
const settleWithin = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  const late = async (): Promise<never> => {
    await Bun.sleep(ms)
    throw new Error(`The read did not finish within ${ms} ms. Workers started: ${BlockedWorker.started}.`)
  }
  return Promise.race([promise, late()])
}

describe('xlsx-to-text in the browser build, with Workers blocked', () => {
  const realWorker = globalThis.Worker
  let xlsx: typeof XlsxToText

  beforeAll(async () => {
    // Under Bun the zip library resolves to a build that never starts a Worker; its browser build inflates large
    // compressed entries in `blob:` Workers.
    xlsx = await bundleForBrowser<typeof XlsxToText>(join(import.meta.dir, 'xlsx-to-text.ts'))
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: BlockedWorker })
  })

  afterAll(() => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: realWorker })
  })

  test('reads a 5,000-row, 50-column workbook without starting a Worker', async () => {
    const rows = Array.from({ length: 5_000 }, (_, row) =>
      Array.from({ length: 50 }, (_, column) => `r${row + 1}c${column + 1}`),
    )

    const { text } = await settleWithin(xlsx.xlsxToText(asFile(workbook(rows))), 4_000)

    const lines = text.split('\n')
    expect(lines[0]).toBe('## Sheet: Sheet1')
    expect(lines[1]).toBe(`Row 1: ${rows[0].join(', ')}`)
    expect(lines.at(-1)).toBe(`Row 5000: ${rows[4_999].join(', ')}`)
    expect(lines).toHaveLength(5_001)
    expect(BlockedWorker.started).toBe(0)
  })

  test('keeps the row numbers of a sheet whose first row and fourth row are missing', async () => {
    const book = asFile(workbook([[], ['Name', 'Cost'], ['Orchid', '137'], [], ['Cedar', '59']]))

    expect((await xlsx.xlsxToText(book)).text).toBe(
      '## Sheet: Sheet1\nRow 2: Name, Cost\nRow 3: Orchid, 137\nRow 5: Cedar, 59',
    )
    expect((await xlsx.readXlsxSheets(book))[0].rows).toEqual([
      [],
      ['Name', 'Cost'],
      ['Orchid', '137'],
      [],
      ['Cedar', '59'],
    ])
  })

  test('refuses a workbook that declares more than 32 MiB unpacked, without unpacking it', async () => {
    // An unknown compression method makes unpacking the entry throw, so this error can only come from the size check.
    // The other parts add about 1 KB, which rounds the total up to 180 MiB.
    const oversized = relabelLastEntry(workbook([['a']]), 179 * mib, 99)

    await expect(xlsx.xlsxToText(asFile(oversized))).rejects.toThrow(
      'This spreadsheet unpacks to 180 MiB, over the 32 MiB limit for reading it.',
    )
  })

  test('unpacks an entry that understates its size only to the size it declares', async () => {
    // The sheet holds 80 MiB of text but declares 1 KiB. Unpacked in full it would parse; cut off at 1 KiB, its XML
    // ends early.
    const understated = relabelLastEntry(workbook([['a'.repeat(80 * mib)]]), 1024, 8)

    await expect(xlsx.xlsxToText(asFile(understated))).rejects.toThrow('unexpected end of file')
  }, 10_000)

  test('counts a stored entry at its stored size, which unpacking copies in full whatever size it declares', async () => {
    await expect(xlsx.xlsxToText(asFile(overlappingStoredEntries(40)))).rejects.toThrow(
      'This spreadsheet unpacks to 40 MiB, over the 32 MiB limit for reading it.',
    )
  })

  test('stops listing a zip whose directory claims more parts than the rewritten zip can hold', async () => {
    // The real directory has five entries; the forged count would keep the listing going far past it.
    await expect(xlsx.xlsxToText(asFile(withZip64Count(workbook([['a']]), 1_000_000)))).rejects.toThrow(
      'This spreadsheet has more than 65535 parts, over the limit for reading it.',
    )
  })

  test('refuses a workbook with two parts of the same name', async () => {
    const parts = unzipSync(workbook([['FIRST']]))
    const zip = zipSync({ ...parts, 'xl/worksheets/sheet9.xml': parts['xl/worksheets/sheet1.xml'] }, { level: 0 })

    await expect(
      xlsx.xlsxToText(asFile(renameEntry(zip, 'xl/worksheets/sheet9.xml', 'xl/worksheets/sheet1.xml'))),
    ).rejects.toThrow('This spreadsheet has two parts with the same name')
  })

  test('reads a workbook that repeats an empty folder entry', async () => {
    const zip = zipSync(
      { 'xl/': new Uint8Array(), 'zz/': new Uint8Array(), ...unzipSync(workbook([['kept']])) },
      { level: 0 },
    )

    expect((await xlsx.xlsxToText(asFile(renameEntry(zip, 'zz/', 'xl/')))).text).toBe('## Sheet: Sheet1\nRow 1: kept')
  })

  test('refuses a part named __proto__, which unpacking would turn into the prototype of its result', async () => {
    const zip = zipSync({ ...unzipSync(workbook([['a']])), protoname: new Uint8Array(1_000) }, { level: 0 })

    await expect(xlsx.xlsxToText(asFile(renameEntry(zip, 'protoname', '__proto__')))).rejects.toThrow(
      'This spreadsheet has a part named __proto__',
    )
  })
})
