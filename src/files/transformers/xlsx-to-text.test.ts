/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { zipSync } from 'fflate'
import type { StoredFile } from '@/lib/file-blob-storage'

const readXlsxFile = mock(async () => [] as { sheet: string; data: unknown[][] }[])

mock.module('read-excel-file/browser', () => ({
  default: readXlsxFile,
}))

const { readXlsxSheets, xlsxToText } = await import('./xlsx-to-text')

const asFile = (): StoredFile =>
  ({
    id: 'file-1',
    filename: 'book.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 0,
    createdAt: 0,
    blob: new Blob([zipSync({})]),
  }) as StoredFile

describe('xlsxToText', () => {
  test('formats a single sheet as a heading plus comma-joined rows, each labeled with its row number', async () => {
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
      text: '## Sheet: Sheet1\nRow 1: Name, Age\nRow 2: Ada, 30',
    })
  })

  test('joins multiple sheets with a blank line between them', async () => {
    readXlsxFile.mockImplementationOnce(async () => [
      { sheet: 'Q1', data: [['Revenue', 100]] },
      { sheet: 'Q2', data: [['Revenue', 150]] },
    ])

    expect(await xlsxToText(asFile())).toEqual({
      text: '## Sheet: Q1\nRow 1: Revenue, 100\n\n## Sheet: Q2\nRow 1: Revenue, 150',
    })
  })

  test('renders a null cell as an empty string, not the literal "null"', async () => {
    readXlsxFile.mockImplementationOnce(async () => [{ sheet: 'Sheet1', data: [['A', null, 'C']] }])

    expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nRow 1: A, , C' })
  })

  test('quotes cells containing a comma or quote', async () => {
    readXlsxFile.mockImplementationOnce(async () => [
      { sheet: 'Sheet1', data: [['Stark, Inc.', 'The "Big" One', 'plain']] },
    ])

    expect(await xlsxToText(asFile())).toEqual({
      text: '## Sheet: Sheet1\nRow 1: "Stark, Inc.", "The ""Big"" One", plain',
    })
  })

  test('keeps a row on one line when a cell holds line breaks', async () => {
    readXlsxFile.mockImplementationOnce(async () => [
      {
        sheet: 'Sheet1',
        data: [
          ['a\r\nb\rc\nd\ve\ff\u0085g\u2028h\u2029i', 'two, "lines"\nhere'],
          ['next', 1],
        ],
      },
    ])

    expect(await xlsxToText(asFile())).toEqual({
      text: '## Sheet: Sheet1\nRow 1: a b c d e f g h i, "two, ""lines"" here"\nRow 2: next, 1',
    })
  })

  // The reader returns row 1 first and fills gaps with blank rows, so a row's index gives its number.
  const withBlankRow4 = [
    {
      sheet: 'Sheet1',
      data: [
        ['Name', 'Cost'],
        ['Orchid', 137],
        ['Maple', 286],
        [null, ''],
        ['Cedar', 59],
      ],
    },
  ]

  test('leaves blank rows out of the text and keeps the row numbers of the rows below them', async () => {
    readXlsxFile.mockImplementationOnce(async () => withBlankRow4)

    expect(await xlsxToText(asFile())).toEqual({
      text: '## Sheet: Sheet1\nRow 1: Name, Cost\nRow 2: Orchid, 137\nRow 3: Maple, 286\nRow 5: Cedar, 59',
    })
  })

  test('keeps a blank row in the sheets as an empty array, so row N of the sheet is row N of a file written from it', async () => {
    readXlsxFile.mockImplementationOnce(async () => withBlankRow4)

    expect((await readXlsxSheets(asFile()))[0].rows).toEqual([
      ['Name', 'Cost'],
      ['Orchid', '137'],
      ['Maple', '286'],
      [],
      ['Cedar', '59'],
    ])
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

      expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nRow 1: Shipped, 2026-08-01' })
    })

    test('keeps the time of day when the cell has one', async () => {
      readXlsxFile.mockImplementationOnce(async () => [
        { sheet: 'Sheet1', data: [['Logged', new Date(Date.UTC(2026, 8, 1, 14, 30))]] },
      ])

      expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nRow 1: Logged, 2026-09-01 14:30' })
    })

    test('includes seconds only when they are not zero', async () => {
      readXlsxFile.mockImplementationOnce(async () => [
        { sheet: 'Sheet1', data: [['Logged', new Date(Date.UTC(2026, 8, 1, 14, 30, 15))]] },
      ])

      expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nRow 1: Logged, 2026-09-01 14:30:15' })
    })

    test('rounds away the float error read-excel-file leaves in times', async () => {
      // read-excel-file floors the Excel serial, so 14:30 comes back as 14:29:59.999.
      readXlsxFile.mockImplementationOnce(async () => [
        { sheet: 'Sheet1', data: [['Logged', new Date(Date.UTC(2026, 8, 1, 14, 29, 59, 999))]] },
      ])

      expect(await xlsxToText(asFile())).toEqual({ text: '## Sheet: Sheet1\nRow 1: Logged, 2026-09-01 14:30' })
    })
  })
})
