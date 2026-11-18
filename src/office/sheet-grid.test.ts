/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { strToU8 } from 'fflate'
import { readerGrid, readerGrids } from './sheet-grid'

const sheet = (sheetData: string, before = '') =>
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${before}<sheetData>${sheetData}</sheetData></worksheet>`

const unreadable = 'A sheet of this spreadsheet is written in a form Excel never writes'

describe('readerGrid', () => {
  test('spans from A1 to the farthest value, however few cells there are', () => {
    const xml = sheet(
      '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="1048576"><c r="XFD1048576" t="s"><v>1</v></c></row>',
    )

    expect(readerGrid(xml)).toEqual({ rows: 1_048_576, cols: 16_384 })
  })

  test('ignores a dimension that claims the whole sheet', () => {
    const xml = sheet('<row r="1"><c r="A1"><v>1</v></c></row>', '<dimension ref="A1:XFD1048576"/>')

    expect(readerGrid(xml)).toEqual({ rows: 1, cols: 1 })
  })

  test('counts the blank rows between two rows with values', () => {
    const xml = sheet('<row r="1"><c r="B1"><v>1</v></c></row><row r="2"/><row r="4"><c r="A4"><v>2</v></c></row>')

    expect(readerGrid(xml)).toEqual({ rows: 4, cols: 2 })
  })

  test('leaves out cells without a value and numbered rows after the last value', () => {
    const xml = sheet(
      '<row r="1"><c r="A1"><v>1</v></c><c r="XFD1" s="1"/></row><row r="1048576" ht="20" customHeight="1"/>',
    )

    expect(readerGrid(xml)).toEqual({ rows: 1, cols: 1 })
  })

  test('counts a value written inline', () => {
    expect(readerGrid(sheet('<row r="3"><c r="C3" t="inlineStr"><is><t>x</t></is></c></row>'))).toEqual({
      rows: 3,
      cols: 3,
    })
  })

  test('keeps the unnumbered rows after the last value, which the reader fills out too', () => {
    const xml = sheet(`<row r="1"><c r="T1"><v>1</v></c></row>${'<row/>'.repeat(5)}`)

    expect(readerGrid(xml)).toEqual({ rows: 6, cols: 20 })
  })

  test('numbers an unnumbered row by its first cell', () => {
    expect(readerGrid(sheet('<row><c r="A7"><v>1</v></c></row>'))).toEqual({ rows: 7, cols: 1 })
  })

  test('counts the larger of two references, and a prefixed one', () => {
    expect(readerGrid(sheet('<row r="1048576" r="1"><c r="A1" r="XFD1"><v>1</v></c></row>'))).toEqual({
      rows: 1_048_576,
      cols: 16_384,
    })
    expect(readerGrid(sheet('<row r="1"><c x:r="XFD1" r="A1"><v>1</v></c></row>'))).toEqual({ rows: 1, cols: 16_384 })
    expect(readerGrid(sheet('<row r="1"><c :r="XFD1" r="A1"><v>1</v></c></row>'))).toEqual({ rows: 1, cols: 16_384 })
    expect(readerGrid(sheet('<row r="1"><c xmlns:x:r="XFD1" r="A1"><v>1</v></c></row>'))).toEqual({
      rows: 1,
      cols: 16_384,
    })
  })

  test('does not read a namespace declaration as a reference', () => {
    expect(readerGrid(sheet('<row r="1"><c xmlns:r="urn:r" r="B1"><v>1</v></c></row>'))).toEqual({ rows: 1, cols: 2 })
  })

  test('reads a prefixed sheet and entity-encoded references', () => {
    const xml =
      '<x:worksheet><x:sheetData><x:row r="&#50;"><x:c r="&#88;FD2"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>'

    expect(readerGrid(xml)).toEqual({ rows: 2, cols: 16_384 })
    // The reader cuts an element name at its first colon, so this is a row.
    expect(readerGrid(sheet('<:row r="1048576"><c r="XFD1048576"><v>1</v></c></:row>'))).toEqual({
      rows: 1_048_576,
      cols: 16_384,
    })
  })

  test('reads a cell tag padded with megabytes of spaces', () => {
    expect(readerGrid(sheet(`<row r="1"><c r="GR1"${' '.repeat(2_097_152)}><v>1</v></c></row>`))).toEqual({
      rows: 1,
      cols: 200,
    })
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
      { part: 'xl/worksheets/sheet1.xml', rows: 2, cols: 2 },
      { part: 'xl/worksheets/odd.xml.rels', rows: 3, cols: 3 },
    ])
  })
})
