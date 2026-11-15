/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { StoredFile } from '@/lib/file-blob-storage'
import { workbook, type WorkbookRows } from '@/test-utils/xlsx-workbook'
import { readXlsxSheets, sheetsToText, xlsxToText } from './xlsx-to-text'

const asFile = (...sheets: readonly WorkbookRows[]): StoredFile => {
  const bytes = workbook(...sheets)
  return {
    id: 'file-1',
    filename: 'book.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: bytes.byteLength,
    createdAt: 0,
    blob: new Blob([bytes]),
  }
}

describe('sheetsToText', () => {
  test('puts a heading over each sheet and labels each row with its number, leaving blank rows out', () => {
    const sheets = [
      { name: 'Q1', rows: [['Name', 'Cost'], [], ['Rent', '10']] },
      { name: 'Q2', rows: [['Revenue', '150']] },
    ]

    expect(sheetsToText(sheets)).toBe(
      '## Sheet: Q1\nRow 1: Name, Cost\nRow 3: Rent, 10\n\n## Sheet: Q2\nRow 1: Revenue, 150',
    )
  })

  test('quotes cells containing a comma or quote', () => {
    expect(sheetsToText([{ name: 'Sheet1', rows: [['Stark, Inc.', 'The "Big" One', 'plain']] }])).toBe(
      '## Sheet: Sheet1\nRow 1: "Stark, Inc.", "The ""Big"" One", plain',
    )
  })

  test('keeps a row on one line when a cell holds line breaks', () => {
    const rows = [
      ['a\r\nb\rc\nd\ve\ff\u0085g\u2028h\u2029i', 'two, "lines"\nhere'],
      ['next', '1'],
    ]

    expect(sheetsToText([{ name: 'Sheet1', rows }])).toBe(
      '## Sheet: Sheet1\nRow 1: a b c d e f g h i, "two, ""lines"" here"\nRow 2: next, 1',
    )
  })
})

describe('reading a workbook', () => {
  // Rows 1 to 3 and 5 hold data and row 4 is blank, the layout where the model used to read Cedar as row 4.
  const blankRow4: WorkbookRows = [['Name', 'Cost'], ['Orchid', 137], ['Maple', 286], [], ['Cedar', 59]]

  test('keeps the row numbers of the rows below a blank row in the text', async () => {
    expect(await xlsxToText(asFile(blankRow4))).toEqual({
      text: '## Sheet: Sheet1\nRow 1: Name, Cost\nRow 2: Orchid, 137\nRow 3: Maple, 286\nRow 5: Cedar, 59',
    })
  })

  test('keeps a blank row in the sheets as an empty array, so row N of the sheet is row N of a file written from it', async () => {
    expect((await readXlsxSheets(asFile(blankRow4)))[0].rows).toEqual([
      ['Name', 'Cost'],
      ['Orchid', '137'],
      ['Maple', '286'],
      [],
      ['Cedar', '59'],
    ])
  })

  test('keeps the number of a row below a blank first row', async () => {
    expect((await readXlsxSheets(asFile([[], ['Title']])))[0].rows).toEqual([[], ['Title']])
  })

  test('reads every sheet under its own name', async () => {
    expect(await xlsxToText(asFile([['Revenue', 100]], [['Revenue', 150.5]]))).toEqual({
      text: '## Sheet: Sheet1\nRow 1: Revenue, 100\n\n## Sheet: Sheet2\nRow 1: Revenue, 150.5',
    })
  })

  test('renders an empty cell between two others as an empty string, not the literal "null"', async () => {
    expect(await xlsxToText(asFile([['A', null, 'C']]))).toEqual({ text: '## Sheet: Sheet1\nRow 1: A, , C' })
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
      expect(await xlsxToText(asFile([['Shipped', new Date(Date.UTC(2026, 7, 1))]]))).toEqual({
        text: '## Sheet: Sheet1\nRow 1: Shipped, 2026-08-01',
      })
    })

    test('keeps the time of day, rounding away the float error the reader leaves in it', async () => {
      // read-excel-file floors the Excel serial, so 14:30 comes back as 14:29:59.999.
      expect(await xlsxToText(asFile([['Logged', new Date(Date.UTC(2026, 8, 1, 14, 30))]]))).toEqual({
        text: '## Sheet: Sheet1\nRow 1: Logged, 2026-09-01 14:30',
      })
    })

    test('includes seconds only when they are not zero', async () => {
      expect(await xlsxToText(asFile([['Logged', new Date(Date.UTC(2026, 8, 1, 14, 30, 15))]]))).toEqual({
        text: '## Sheet: Sheet1\nRow 1: Logged, 2026-09-01 14:30:15',
      })
    })
  })
})
