/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { StoredFile } from '@/lib/file-blob-storage'

const readXlsxFile = mock(async () => [] as { sheet: string; data: unknown[][] }[])

mock.module('read-excel-file/browser', () => ({
  default: readXlsxFile,
}))

const { xlsxToText } = await import('./xlsx-to-text')

const asFile = (): StoredFile =>
  ({
    id: 'file-1',
    filename: 'book.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 0,
    createdAt: 0,
    blob: new Blob(),
  }) as StoredFile

describe('xlsxToText', () => {
  test('formats a single sheet as a heading plus comma-joined rows', async () => {
    readXlsxFile.mockImplementationOnce(async () => [
      {
        sheet: 'Sheet1',
        data: [
          ['Name', 'Age'],
          ['Ada', 30],
        ],
      },
    ])

    expect(await xlsxToText(asFile())).toEqual({
      text: '## Sheet: Sheet1\nName, Age\nAda, 30',
    })
  })

  test('joins multiple sheets with a blank line between them', async () => {
    readXlsxFile.mockImplementationOnce(async () => [
      { sheet: 'Q1', data: [['Revenue', 100]] },
      { sheet: 'Q2', data: [['Revenue', 150]] },
    ])

    expect(await xlsxToText(asFile())).toEqual({
      text: '## Sheet: Q1\nRevenue, 100\n\n## Sheet: Q2\nRevenue, 150',
    })
  })

  test('renders a null cell as an empty string, not the literal "null"', async () => {
    readXlsxFile.mockImplementationOnce(async () => [{ sheet: 'Sheet1', data: [['A', null, 'C']] }])

    expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nA, , C' })
  })

  test('quotes cells containing a comma, quote, or line break', async () => {
    readXlsxFile.mockImplementationOnce(async () => [
      { sheet: 'Sheet1', data: [['Stark, Inc.', 'The "Big" One', 'line one\nline two', 'plain']] },
    ])

    expect(await xlsxToText(asFile())).toEqual({
      text: '## Sheet: Sheet1\n"Stark, Inc.", "The ""Big"" One", "line one\nline two", plain',
    })
  })

  test('skips rows where every cell is empty', async () => {
    readXlsxFile.mockImplementationOnce(async () => [
      {
        sheet: 'Sheet1',
        data: [
          ['Name', 'Age'],
          [null, null],
          ['', null],
          ['Ada', 30],
        ],
      },
    ])

    expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nName, Age\nAda, 30' })
  })

  // `bun test` runs in UTC, which hides timezone bugs: read-excel-file hands back
  // spreadsheet dates as UTC midnight, so formatting them in local time shifts the
  // day for anyone west of Greenwich. Pin a western zone for these cases.
  describe('dates, viewed from a timezone west of UTC', () => {
    const originalTimeZone = process.env.TZ

    beforeAll(() => {
      process.env.TZ = 'America/Halifax'
    })

    afterAll(() => {
      // `bun test` defaults to UTC without setting TZ, and assigning undefined back
      // drops the process into the machine's local zone for every later test file.
      process.env.TZ = originalTimeZone ?? 'UTC'
    })

    test('keeps the calendar day written in the sheet', async () => {
      readXlsxFile.mockImplementationOnce(async () => [
        { sheet: 'Sheet1', data: [['Shipped', new Date(Date.UTC(2026, 7, 1))]] },
      ])

      expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nShipped, 2026-08-01' })
    })

    test('keeps the time of day when the cell has one', async () => {
      readXlsxFile.mockImplementationOnce(async () => [
        { sheet: 'Sheet1', data: [['Logged', new Date(Date.UTC(2026, 8, 1, 14, 30))]] },
      ])

      expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nLogged, 2026-09-01 14:30' })
    })

    test('includes seconds only when they are not zero', async () => {
      readXlsxFile.mockImplementationOnce(async () => [
        { sheet: 'Sheet1', data: [['Logged', new Date(Date.UTC(2026, 8, 1, 14, 30, 15))]] },
      ])

      expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nLogged, 2026-09-01 14:30:15' })
    })

    test('rounds away the float error read-excel-file leaves in times', async () => {
      // read-excel-file floors the Excel serial, so 14:30 comes back as 14:29:59.999.
      readXlsxFile.mockImplementationOnce(async () => [
        { sheet: 'Sheet1', data: [['Logged', new Date(Date.UTC(2026, 8, 1, 14, 29, 59, 999))]] },
      ])

      expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nLogged, 2026-09-01 14:30' })
    })
  })
})
