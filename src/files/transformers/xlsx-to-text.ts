/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StoredFile } from '@/lib/file-blob-storage'
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

/** True when a row has no content, so blank spacer rows don't reach the model as `, , ,`. */
const isEmptyRow = (row: (CellValue | null)[]): boolean => row.every((cell) => cell === null || cell === '')

/** Quotes a field that contains a separator, quote, or line break, doubling any
 *  embedded quotes, so `Stark, Inc.` stays one cell instead of reading as two. */
const csvField = (text: string): string => (/[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text)

/**
 * Extracts a plain-text table dump from an XLSX blob via a lazily-imported
 * read-excel-file. Multiple sheets are concatenated with a heading per sheet so
 * the model can tell them apart; rows are joined as CSV-ish text rather than a
 * Markdown table, since spreadsheet column counts and widths vary too widely
 * for a fixed-width table to stay readable.
 */
export const xlsxToText = async (file: StoredFile): Promise<{ text: string }> => {
  const { default: readXlsxFile } = await import('read-excel-file/browser')
  const sheets = await readXlsxFile(file.blob)
  const text = sheets
    .map(({ sheet, data }) => {
      const rows = data
        .filter((row) => !isEmptyRow(row))
        .map((row) => row.map((cell) => csvField(cellText(cell))).join(', '))
        .join('\n')
      return `## Sheet: ${sheet}\n${rows}`
    })
    .join('\n\n')
  return { text: text.trim() }
}
