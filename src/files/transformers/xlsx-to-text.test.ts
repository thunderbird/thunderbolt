/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
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

  test('marks the sheets hidden from the tabs', async () => {
    const parts = unzipSync(workbook([['shown']], [['hidden']], [['very hidden']]))
    parts['xl/workbook.xml'] = strToU8(
      strFromU8(parts['xl/workbook.xml'])
        .replace('<sheets>', '<sheets><!-- <sheet name="Old" state="hidden"/> -->')
        .replace('<sheet name="Sheet2"', '<sheet state="hidden" name="Sheet2"')
        .replace('<sheet name="Sheet3"', '<sheet name="Sheet3" state=\'veryHidden\''),
    )
    const bytes = zipSync(parts)
    const file = { ...asFile(), size: bytes.byteLength, blob: new Blob([bytes]) }

    expect((await xlsxToText(file)).text).toBe(
      '## Sheet: Sheet1\nRow 1: shown\n\n## Sheet: Sheet2 (hidden)\nRow 1: hidden\n\n## Sheet: Sheet3 (hidden)\nRow 1: very hidden',
    )
  })

  test('marks a hidden sheet whose name holds a >', async () => {
    const parts = unzipSync(workbook([['shown']], [['hidden']]))
    parts['xl/workbook.xml'] = strToU8(
      strFromU8(parts['xl/workbook.xml']).replace('<sheet name="Sheet2"', '<sheet name="Q1>Q2" state="hidden"'),
    )
    const bytes = zipSync(parts)
    const file = { ...asFile(), size: bytes.byteLength, blob: new Blob([bytes]) }

    expect((await xlsxToText(file)).text).toBe(
      '## Sheet: Sheet1\nRow 1: shown\n\n## Sheet: Q1>Q2 (hidden)\nRow 1: hidden',
    )
  })

  describe('the grid the sheet reader builds', () => {
    /** A workbook whose sheets hold this `sheetData` markup. */
    const withSheetData = (...sheetData: readonly string[]): StoredFile => {
      const parts = unzipSync(workbook(...sheetData.map(() => [['a']])))
      sheetData.forEach((data, index) => {
        parts[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD1048576"/><sheetData>${data}</sheetData></worksheet>`,
        )
      })
      const bytes = zipSync(parts)
      return { ...asFile(), size: bytes.byteLength, blob: new Blob([bytes]) }
    }
    const corners = (last: string, row: number) =>
      `<row r="1"><c r="A1"><v>1</v></c></row><row r="${row}"><c r="${last}${row}"><v>2</v></c></row>`

    test('refuses a sheet whose two values sit at A1 and XFD1048576, naming the sheet and its size', async () => {
      await expect(readXlsxSheets(withSheetData(corners('XFD', 1_048_576)))).rejects.toThrow(
        'Sheet "Sheet1" spans 1048576 rows by 16384 columns, which takes this spreadsheet to 17179869184 cells, over the 6000000-cell limit for reading it.',
      )
    })

    test('counts the sheets together and names the one that passes the limit', async () => {
      // 1,000 rows by 4,000 columns: four million cells each, under the limit alone.
      await expect(xlsxToText(withSheetData(corners('EWV', 1_000), corners('EWV', 1_000)))).rejects.toThrow(
        'Sheet "Sheet2" spans 1000 rows by 4000 columns, which takes this spreadsheet to 8000000 cells',
      )
    })

    test('reads a sheet at the limit', async () => {
      // 1,000 rows by 6,000 columns.
      const { text } = await xlsxToText(withSheetData(corners('HVT', 1_000)))

      expect(text.split('\n').at(-1)).toStartWith('Row 1000: , , ')
    })

    test('reads a sheet whose dimension claims the whole sheet but holds one cell', async () => {
      expect(await xlsxToText(withSheetData('<row r="1"><c r="A1"><v>1</v></c></row>'))).toEqual({
        text: '## Sheet: Sheet1\nRow 1: 1',
      })
    })

    test('reads a sheet with a styled empty cell and a sized empty row at the far corner', async () => {
      const data =
        '<row r="1"><c r="A1"><v>1</v></c><c r="XFD1" s="1"/></row><row r="1048576" ht="20" customHeight="1"/>'

      expect(await xlsxToText(withSheetData(data))).toEqual({ text: '## Sheet: Sheet1\nRow 1: 1' })
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
