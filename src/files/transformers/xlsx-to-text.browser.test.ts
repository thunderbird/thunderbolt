/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { build, type Rolldown } from 'vite'
import type { StoredFile } from '@/lib/file-blob-storage'
import type * as XlsxToText from './xlsx-to-text'

const mib = 1024 * 1024

/**
 * Bundles xlsx-to-text.ts into one ES module, as the app's build does. Under Bun the zip library resolves to a build
 * that never starts a Worker, while its browser build inflates large compressed entries in `blob:` Workers.
 */
const bundleForBrowser = async (dir: string): Promise<typeof XlsxToText> => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: join(import.meta.dir, 'xlsx-to-text.ts'), formats: ['es'] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  // `write: false` without `watch` resolves to one output.
  const [{ output }] = [result].flat() as Rolldown.RolldownOutput[]
  const path = join(dir, 'xlsx-to-text.mjs')
  writeFileSync(path, output[0].code)
  return import(path)
}

/** `A` for column 0, `AX` for column 49. */
const columnName = (index: number): string =>
  `${index < 26 ? '' : columnName(Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`

/** A one-sheet workbook of inline strings, deflated as Excel saves it. */
const workbook = (rows: string[][]) => {
  const sheetData = rows
    .map(
      (cells, row) =>
        `<row r="${row + 1}">${cells
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

const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])

/** Rewrites what the central directory says about the zip's last entry: its unpacked size and compression method. */
const relabelLastEntry = (zip: Uint8Array<ArrayBuffer>, size: number, method: number) => {
  const central = Buffer.from(zip).lastIndexOf(centralSignature)
  const view = new DataView(zip.buffer)
  view.setUint16(central + 10, method, true)
  view.setUint32(central + 24, size, true)
  return zip
}

/** A zip whose central directory lists `count` stored entries that all point at one 1 MiB payload and declare 0 bytes. */
const overlappingStoredEntries = (count: number) => {
  const zip = zipSync({ 'payload.bin': new Uint8Array(mib) }, { level: 0 })
  const central = Buffer.from(zip).indexOf(centralSignature)
  const record = zip.slice(central, zip.length - 22)
  const records = Array.from({ length: count }, (_, index) => {
    const copy = record.slice()
    new DataView(copy.buffer).setUint32(24, 0, true)
    copy.set(strToU8(`file${String(index).padStart(3, '0')}.bin`), 46)
    return copy
  })
  const end = zip.slice(-22)
  const view = new DataView(end.buffer)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, count * record.length, true)
  return new Uint8Array(Buffer.concat([zip.subarray(0, central), ...records, end]))
}

/** Renames an entry in its local header and its central directory record. `to` must be as long as `from`. */
const renameEntry = (zip: Uint8Array<ArrayBuffer>, from: string, to: string) => {
  const bytes = Buffer.from(zip.buffer)
  bytes.write(to, bytes.indexOf(from))
  bytes.write(to, bytes.indexOf(from))
  return zip
}

/** Moves the entry count into a ZIP64 end record, the only place a count over 65,535 fits. */
const withZip64Count = (zip: Uint8Array<ArrayBuffer>, count: number) => {
  const end = zip.byteLength - 22
  const classic = new DataView(zip.buffer)
  // A ZIP64 end of central directory record (56 bytes), then its locator (20 bytes).
  const zip64 = new DataView(new ArrayBuffer(76))
  zip64.setUint32(0, 0x06064b50, true)
  zip64.setBigUint64(4, 44n, true)
  zip64.setUint16(12, 45, true)
  zip64.setUint16(14, 45, true)
  zip64.setBigUint64(24, BigInt(count), true)
  zip64.setBigUint64(32, BigInt(count), true)
  zip64.setBigUint64(40, BigInt(classic.getUint32(end + 12, true)), true)
  zip64.setBigUint64(48, BigInt(classic.getUint32(end + 16, true)), true)
  zip64.setUint32(56, 0x07064b50, true)
  zip64.setBigUint64(64, BigInt(end), true)
  zip64.setUint32(72, 1, true)
  const classicEnd = zip.slice(end)
  new DataView(classicEnd.buffer).setUint16(8, 0xffff, true)
  new DataView(classicEnd.buffer).setUint16(10, 0xffff, true)
  return new Uint8Array(Buffer.concat([zip.subarray(0, end), new Uint8Array(zip64.buffer), classicEnd]))
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
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-to-text-'))
  const realWorker = globalThis.Worker
  let xlsx: typeof XlsxToText

  beforeAll(async () => {
    xlsx = await bundleForBrowser(dir)
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: BlockedWorker })
  })

  afterAll(() => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: realWorker })
    rmSync(dir, { recursive: true, force: true })
  })

  test('reads a 5,000-row, 50-column workbook without starting a Worker', async () => {
    const rows = Array.from({ length: 5_000 }, (_, row) =>
      Array.from({ length: 50 }, (_, column) => `r${row + 1}c${column + 1}`),
    )

    const { text } = await settleWithin(xlsx.xlsxToText(asFile(workbook(rows))), 4_000)

    const lines = text.split('\n')
    expect(lines[0]).toBe('## Sheet: Sheet1')
    expect(lines[1]).toBe(rows[0].join(', '))
    expect(lines.at(-1)).toBe(rows[4_999].join(', '))
    expect(lines).toHaveLength(5_001)
    expect(BlockedWorker.started).toBe(0)
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

    expect((await xlsx.xlsxToText(asFile(renameEntry(zip, 'zz/', 'xl/')))).text).toBe('## Sheet: Sheet1\nkept')
  })

  test('refuses a part named __proto__, which unpacking would turn into the prototype of its result', async () => {
    const zip = zipSync({ ...unzipSync(workbook([['a']])), protoname: new Uint8Array(1_000) }, { level: 0 })

    await expect(xlsx.xlsxToText(asFile(renameEntry(zip, 'protoname', '__proto__')))).rejects.toThrow(
      'This spreadsheet has a part named __proto__',
    )
  })
})
