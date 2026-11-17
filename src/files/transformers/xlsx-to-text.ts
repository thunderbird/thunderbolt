/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'
import type { visitStartTags } from '@/office/xlsx-drawings'
import type { UnzipFileInfo } from 'fflate'
import type { CellValue } from 'read-excel-file/browser'

/**
 * Renders a spreadsheet date as ISO 8601: `2026-09-01`, or `2026-09-01 14:30`
 * when the cell has a time, with seconds only when they aren't zero. ISO reads
 * the same for any model regardless of locale (`8/1/2026` is ambiguous).
 *
 * Spreadsheets store dates without a timezone and read-excel-file represents them
 * as UTC, so reading the UTC fields reproduces the cell for every user; local
 * time would shift the day for anyone west of Greenwich. read-excel-file also
 * floors the Excel serial, leaving float error like 14:29:59.999 for 14:30, so
 * round to the nearest second first.
 */
const formatSpreadsheetDate = (value: Date): string => {
  const rounded = new Date(Math.round(value.getTime() / 1000) * 1000)
  const [date, time] = rounded.toISOString().slice(0, 19).split('T')
  if (time === '00:00:00') {
    return date
  }
  return `${date} ${time.endsWith(':00') ? time.slice(0, 5) : time}`
}

/** Renders one cell as plain text. */
const cellText = (value: CellValue | null): string => {
  if (value === null) {
    return ''
  }
  if (value instanceof Date) {
    return formatSpreadsheetDate(value)
  }
  return String(value)
}

/** Puts a cell on one line and quotes it when it holds a comma or quote, doubling any embedded quotes, so `Stark, Inc.`
 *  stays one cell. It flattens the same line breaks as `toTsv`, so a row is one labeled line that a preview cannot cut
 *  in half, and a cell reads the same here as in the sheet's `.tsv`. */
const csvField = (text: string): string => {
  const line = text.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ')
  return /[",]/.test(line) ? `"${line.replaceAll('"', '""')}"` : line
}

/** One worksheet as text cells. `rows[i]` is row `i + 1` of the sheet: a blank row stays as an empty array, so a `.tsv`
 *  written from it keeps the sheet's row numbers as line numbers. */
export type SpreadsheetSheet = {
  readonly name: string
  readonly rows: string[][]
  /** Hidden from the sheet tabs, though still in the workbook. */
  readonly hidden?: boolean
}

/**
 * Whether each sheet `xl/workbook.xml` lists is hidden, in the order the sheet reader returns them: every `<sheet>`
 * with a name, whatever its prefix, outside comments. Run only on XML the reader has parsed, so every tag closes.
 */
const hiddenSheets = (workbookXml: string, visit: typeof visitStartTags): boolean[] => {
  const hidden: boolean[] = []
  visit(workbookXml.replace(/<!--[\s\S]*?-->/g, ''), new Set(['sheet']), (_, attributes) => {
    if (attributes.some(({ local }) => local === 'name')) {
      hidden.push(/^(?:hidden|veryHidden)$/.test(attributes.findLast(({ local }) => local === 'state')?.value ?? ''))
    }
    return true
  })
  return hidden
}

const mib = 1024 * 1024
// WebKit's peak memory while reading is about 16 times the unpacked size, so this keeps it near 0.5 GiB.
const maxUnpackedMib = 32
// The rewritten zip is a classic (non-ZIP64) zip, which stores its entry count in 16 bits.
const maxEntries = 65_535

/**
 * Throws, with a message for the model, when unpacking and rewriting a workbook's zip could exhaust memory or change
 * what the reader sees. A deflated entry inflates to at most the size it declares, but a stored one is copied at its
 * compressed size, which can be larger, so each entry counts at the larger of the two.
 */
const checkEntries = (entries: readonly UnzipFileInfo[]): void => {
  const unpacked = entries.reduce((total, { size, originalSize }) => total + Math.max(size, originalSize), 0)
  if (unpacked > maxUnpackedMib * mib) {
    throw new Error(
      `This spreadsheet unpacks to ${Math.ceil(unpacked / mib)} MiB, over the ${maxUnpackedMib} MiB limit for reading it.`,
    )
  }
  const names = entries.map(({ name }) => name)
  // Unpacking stores each entry under its name in a plain object, where `__proto__` would replace the prototype.
  if (names.includes('__proto__')) {
    throw new Error('This spreadsheet has a part named __proto__, which cannot be read safely.')
  }
  // Repeated empty folder entries are harmless; repeated files leave it unclear which one the reader sees.
  const files = names.filter((name) => !name.endsWith('/'))
  if (new Set(files).size < files.length) {
    throw new Error('This spreadsheet has two parts with the same name, so it is unclear which one to read.')
  }
}

/**
 * Reads every worksheet of an XLSX blob as text cells, once {@link checkEntries} accepts its zip. The zip and sheet
 * readers are imported lazily.
 */
export const readXlsxSheets = async (file: StoredFile): Promise<SpreadsheetSheet[]> => {
  const [{ default: readXlsxFile }, { strFromU8, unzipSync, zipSync }, { unzipWithinLimits }, { visitStartTags }] =
    await Promise.all([
      import('read-excel-file/browser'),
      import('fflate'),
      import('@/files/unzip-within-limits'),
      import('@/office/xlsx-drawings'),
    ])
  const zip = new Uint8Array(await file.blob.arrayBuffer())
  const entries: UnzipFileInfo[] = []
  unzipSync(zip, {
    filter: (entry) => {
      // Checked here because a forged entry count keeps this listing going past the end of the real directory.
      if (entries.length === maxEntries) {
        throw new Error(`This spreadsheet has more than ${maxEntries} parts, over the limit for reading it.`)
      }
      entries.push(entry)
      return false
    },
  })
  checkEntries(entries)
  // `unzipSync` inflates a part that understates its size in full before dropping what does not fit, which can freeze
  // the tab for seconds on a GiB of data. This stops each part at its declared size.
  const parts = unzipWithinLimits(zip, { bytes: maxUnpackedMib * mib, parts: maxEntries })
  // The app's CSP blocks the `blob:` Workers the reader starts to inflate compressed sheets, so store every entry.
  const sheets = await readXlsxFile(zipSync(Object.fromEntries(parts), { level: 0 }).buffer)
  const hidden = hiddenSheets(strFromU8(parts.get('xl/workbook.xml') ?? new Uint8Array()), visitStartTags)
  return sheets.map(({ sheet, data }, index) => ({
    name: sheet,
    hidden: hidden[index] ?? false,
    // The reader pads a blank row to the sheet's width with null, its value for every empty cell; an empty array keeps
    // the row one byte in a `.tsv`.
    rows: data.map((row) => (row.every((cell) => cell === null) ? [] : row.map(cellText))),
  }))
}

/**
 * Renders sheets as a plain-text table dump. Multiple sheets are concatenated
 * with a heading per sheet so the model can tell them apart; rows are joined as
 * CSV-ish text rather than a Markdown table, since spreadsheet column counts and
 * widths vary too widely for a fixed-width table to stay readable. Blank rows are
 * left out and every other row is labeled with its row number, so the model reads
 * row numbers instead of counting lines.
 */
export const sheetsToText = (sheets: readonly SpreadsheetSheet[]): string =>
  sheets
    .map(({ name, rows, hidden }) => {
      const lines = rows.flatMap((row, index) =>
        row.length === 0 ? [] : [`Row ${index + 1}: ${row.map(csvField).join(', ')}`],
      )
      return `## Sheet: ${name}${hidden ? ' (hidden)' : ''}\n${lines.join('\n')}`
    })
    .join('\n\n')
    .trim()

/** Extracts a plain-text table dump from an XLSX blob — see {@link sheetsToText}. */
export const xlsxToText = async (file: StoredFile): Promise<{ text: string }> => ({
  text: sheetsToText(await readXlsxSheets(file)),
})
