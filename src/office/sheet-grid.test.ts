/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { strToU8 } from 'fflate'
import { readerGrid, readerGrids } from './sheet-grid'

const sheet = (sheetData: string, before = '') =>
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${before}<sheetData>${sheetData}</sheetData></worksheet>`

const unreadable = 'A sheet of this spreadsheet is written in a form Excel never writes'

/** The count for a grid of `rows` rows built and kept, filled out to `cols` columns. */
const grid = (rows: number, cols: number) => ({ rows, cols, cells: rows * cols })

describe('readerGrid', () => {
  test('spans from A1 to the farthest value, however few cells there are', () => {
    const xml = sheet(
      '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="1048576"><c r="XFD1048576" t="s"><v>1</v></c></row>',
    )

    expect(readerGrid(xml)).toEqual(grid(1_048_576, 16_384))
  })

  test('ignores a dimension that claims the whole sheet', () => {
    const xml = sheet('<row r="1"><c r="A1"><v>1</v></c></row>', '<dimension ref="A1:XFD1048576"/>')

    expect(readerGrid(xml)).toEqual(grid(1, 1))
  })

  test('counts the blank rows between two rows with values', () => {
    const xml = sheet('<row r="1"><c r="B1"><v>1</v></c></row><row r="2"/><row r="4"><c r="A4"><v>2</v></c></row>')

    expect(readerGrid(xml)).toEqual(grid(4, 2))
  })

  test('keeps no cell without a value nor numbered row after the last value, but counts the rows built', () => {
    const xml = sheet(
      '<row r="1"><c r="A1"><v>1</v></c><c r="XFD1" s="1"/></row><row r="1048576" ht="20" customHeight="1"/>',
    )

    expect(readerGrid(xml)).toEqual({ rows: 1_048_576, cols: 1, cells: 1 })
  })

  test('counts the rows the reader builds for a sheet without any value', () => {
    expect(readerGrid(sheet('<row r="100000"/>'))).toEqual({ rows: 100_000, cols: 0, cells: 0 })
  })

  test('counts a value written inline', () => {
    expect(readerGrid(sheet('<row r="3"><c r="C3" t="inlineStr"><is><t>x</t></is></c></row>'))).toEqual(grid(3, 3))
  })

  test.each(['<v/>', '<v></v>', '<x:v />', '<is/>', '<is></is>'])(
    'takes %s for no value, as the reader does',
    (empty) => {
      const xml = sheet(
        `<row r="1"><c r="A1"><v>42</v></c></row><row r="1048576"><c r="XFD1048576"><f>A1*2</f>${empty}</c></row>`,
      )

      expect(readerGrid(xml)).toEqual({ rows: 1_048_576, cols: 1, cells: 1 })
    },
  )

  test('counts a value that holds only a space, which the reader reads as zero', () => {
    expect(readerGrid(sheet('<row r="1"><c r="C1"><v> </v></c></row>'))).toEqual(grid(1, 3))
  })

  test('keeps the unnumbered rows after the last value, which the reader fills out too', () => {
    const xml = sheet(`<row r="1"><c r="T1"><v>1</v></c></row>${'<row/>'.repeat(5)}`)

    expect(readerGrid(xml)).toEqual(grid(6, 20))
  })

  test('numbers an unnumbered row by its first cell', () => {
    expect(readerGrid(sheet('<row><c r="A7"><v>1</v></c></row>'))).toEqual(grid(7, 1))
  })

  test('counts the larger of two references, and a prefixed one', () => {
    expect(readerGrid(sheet('<row r="1048576" r="1"><c r="A1" r="XFD1"><v>1</v></c></row>'))).toEqual(
      grid(1_048_576, 16_384),
    )
    expect(readerGrid(sheet('<row r="1"><c x:r="XFD1" r="A1"><v>1</v></c></row>'))).toEqual(grid(1, 16_384))
    expect(readerGrid(sheet('<row r="1"><c :r="XFD1" r="A1"><v>1</v></c></row>'))).toEqual(grid(1, 16_384))
    expect(readerGrid(sheet('<row r="1"><c xmlns:x:r="XFD1" r="A1"><v>1</v></c></row>'))).toEqual(grid(1, 16_384))
  })

  test('does not read a namespace declaration as a reference', () => {
    expect(readerGrid(sheet('<row r="1"><c xmlns:r="urn:r" r="B1"><v>1</v></c></row>'))).toEqual(grid(1, 2))
  })

  test('reads a prefixed sheet and entity-encoded references', () => {
    const xml =
      '<x:worksheet><x:sheetData><x:row r="&#50;"><x:c r="&#88;FD2"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>'

    expect(readerGrid(xml)).toEqual(grid(2, 16_384))
    // The reader cuts an element name at its first colon, so this is a row.
    expect(readerGrid(sheet('<:row r="1048576"><c r="XFD1048576"><v>1</v></c></:row>'))).toEqual(
      grid(1_048_576, 16_384),
    )
  })

  test('reads a cell tag padded with megabytes of spaces', () => {
    expect(readerGrid(sheet(`<row r="1"><c r="GR1"${' '.repeat(2_097_152)}><v>1</v></c></row>`))).toEqual(grid(1, 200))
  })

  test('reads a tag with space around the = of an attribute other than r as it reads one without', () => {
    const spaced = sheet('<row r="3" ht = "20" x:dyDescent\n=\t\'0.2\'><c r="C3" s ="1"><v>42</v></c></row>')
    const plain = sheet('<row r="3" ht="20" x:dyDescent=\'0.2\'><c r="C3" s="1"><v>42</v></c></row>')

    expect(readerGrid(spaced)).toEqual(readerGrid(plain))
    expect(readerGrid(spaced)).toEqual(grid(3, 3))
  })

  test('refuses references Excel never writes', () => {
    expect(() => readerGrid(sheet('<row r="1e6"/>'))).toThrow(
      'A row of the workbook has a reference Excel never writes.',
    )
    expect(() => readerGrid(sheet('<row r="1"><c r="AAAA1"><v>1</v></c></row>'))).toThrow(
      'A cell of the workbook has a reference Excel never writes.',
    )
  })

  test('refuses a tag the reader could read otherwise', () => {
    // The reader keeps reading after a misplaced quote and finds an `r` this scan would read as part of a value.
    expect(() => readerGrid(sheet('<row r="1"><c a="1"b=" r="XFD1"><v>1</v></c></row>'))).toThrow(unreadable)
    // The reader takes a form feed for a space.
    expect(() => readerGrid(sheet('<row r="1"><c\fr="XFD1"><v>1</v></c></row>'))).toThrow(unreadable)
    // The reader skips an `r` with space around its `=`, and leaves the row unnumbered.
    expect(() => readerGrid(sheet('<row r = "1048576"/>'))).toThrow(unreadable)
    expect(() => readerGrid(sheet('<row x:r= "1048576"/>'))).toThrow(unreadable)
    // It also reads the value of a spaced attribute as more attributes, here an `r`.
    expect(() => readerGrid(sheet('<row ht = " r=\'1048576\'"/>'))).toThrow(unreadable)
  })

  test('refuses at once a tag of many attributes that ends in a form XML forbids', () => {
    expect(() => readerGrid(sheet(`<row r="1"${' a="1"'.repeat(64)} b/>`))).toThrow(unreadable)
  })

  test('refuses a second sheetData, where the reader starts its rows over', () => {
    expect(() => readerGrid(`${sheet('<row r="1048576"/>')}${sheet('')}`)).toThrow(unreadable)
  })

  test('refuses rows past the last one Excel has', () => {
    expect(() => readerGrid(sheet(`<row r="1048576"/><row/>`))).toThrow(unreadable)
  })
})

describe('readerGrids', () => {
  test('measures every XML part with a sheetData, and reads no tag inside a comment', () => {
    const parts = new Map([
      [
        'xl/worksheets/sheet1.xml',
        strToU8(sheet('<row r="2"><c r="B2"><v>1</v></c></row><!-- <c r="XFD2"><v>1</v></c> -->')),
      ],
      ['xl/worksheets/odd.xml.rels', strToU8(sheet('<row r="3"><c r="C3"><v>1</v></c></row>'))],
      ['xl/media/image1.png', strToU8(sheet('<row r="9"><c r="Z9"><v>1</v></c></row>'))],
      ['xl/styles.xml', strToU8('<styleSheet/>')],
    ])

    expect(readerGrids(parts)).toEqual([
      { part: 'xl/worksheets/sheet1.xml', ...grid(2, 2) },
      { part: 'xl/worksheets/odd.xml.rels', ...grid(3, 3) },
    ])
  })
})
