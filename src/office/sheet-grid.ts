/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strFromU8 } from 'fflate'
import { columnNumber } from './formula-cache'
import { readAttributes, scannableXml, type XmlAttribute } from './xlsx-drawings'

// Excel's last row and column, XFD.
const maxRow = 1_048_576
const maxColumn = 16_384

/** A row's `r`, which must be written as Excel writes it: Excelize reads other spellings the scan would not. */
export const rowNumber = (ref: string) => {
  const row = /^[1-9][0-9]*$/.test(ref) ? Number(ref) : 0
  if (row < 1 || row > maxRow) {
    throw new Error('A row of the workbook has a reference Excel never writes.')
  }
  return row
}

/** A cell's `r`, which must be written as Excel writes it, such as `B12`: not `b12`, `$B$12` or `B+12`. */
export const cellReference = (ref: string) => {
  const [, letters, digits] = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref) ?? []
  const col = letters ? columnNumber(letters) : 0
  const row = digits ? Number(digits) : 0
  if (col < 1 || col > maxColumn || row < 1 || row > maxRow) {
    throw new Error('A cell of the workbook has a reference Excel never writes.')
  }
  return { row, col }
}

// Every start tag the text reader could take for one of these: it cuts an element name at its first colon.
const readerTag = /<(?:[^\s<>/:!?="']*:)?(sheetData|row|c|v|is)(?=[\s/>])/g
// The same tag as XML writes it, the only form in which the reader and `readAttributes` find the same attributes. The
// reader skips an attribute with space around its `=`, and finds no attribute in its value while that holds no `=`.
// The two forms of an attribute must not overlap, or a tag that fails at its end backtracks exponentially.
const wellFormedTag =
  /<[^\s<>/!?="']*((?:[\t\n\r ]+[^\s=<>"'/]+(?:=(?:"[^"<]*"|'[^'<]*')|(?:[\t\n\r ]+=[\t\n\r ]*|=[\t\n\r ]+)(?:"[^"<=]*"|'[^'<=]*')))*)[\t\n\r ]*\/?>/y
// An `r` with space around its `=`: the reader skips it, so it numbers nothing there.
const spacedReference = /[\s:]r(?:[\t\n\r ]+=|=[\t\n\r ]+)/

/**
 * The values of a tag the text reader could take for its `r`: of two attributes with one name it keeps the first, and
 * it cuts each name at its first colon, unless that colon ends `xmlns`.
 */
const references = (attributes: readonly XmlAttribute[]) =>
  attributes.flatMap(({ prefix, local, value }) => {
    const name = prefix ? `${prefix}:${local}` : local
    return name.slice(name.indexOf(':', name.startsWith('xmlns:') ? 6 : 0) + 1) === 'r' ? [value] : []
  })

const unreadable = () =>
  new Error('A sheet of this spreadsheet is written in a form Excel never writes, so its size cannot be checked.')

/** The `r` values of the row or cell tag at `index`, refusing a tag the reader could read otherwise. */
const referencesAt = (xml: string, index: number) => {
  wellFormedTag.lastIndex = index
  const [, attributeText] = wellFormedTag.exec(xml) ?? []
  if (attributeText === undefined || spacedReference.test(attributeText)) {
    throw unreadable()
  }
  return references(readAttributes(attributeText))
}

/** Whether the value tag at `index` is written empty, `<v/>` or `<v></v>`, which the reader takes for no value. */
const emptyAt = (xml: string, index: number) => {
  wellFormedTag.lastIndex = index
  const [tag] = wellFormedTag.exec(xml) ?? []
  return tag !== undefined && (tag.endsWith('/>') || xml.startsWith('</', index + tag.length))
}

/**
 * The rows the text reader builds from a sheet part, the columns it fills them out to and the cells of the grid it
 * keeps, counted without building it. The reader adds a row for every row number it skips and fills each kept row out
 * to the last column that holds a value anywhere in the sheet, so values at A1 and XFD1048576 make 17 billion cells.
 * It ignores `<dimension>`, and drops the rows after the last one with a value unless none of them is numbered, but
 * only once it has built them. Where the reader could read the part otherwise, the count runs high or the part is
 * refused: every `r` of a tag counts, a cell's row can number its row, a value that is not written empty belongs to
 * the last cell before it, and a tag written in a form XML forbids, a second `sheetData` or a row past Excel's last
 * refuses the part. Run on {@link scannableXml}'s output.
 */
export const readerGrid = (xml: string) => {
  // `rows` counts every row the reader adds; `dataRows` those up to the last value, and `unnumbered` the rows after it
  // without an `r`, which the reader keeps.
  const grid = { rows: 0, cols: 0, cellCol: 0, dataRows: 0, unnumbered: 0, sheetData: 0 }
  for (const { 1: tag, index } of xml.matchAll(readerTag)) {
    // Only row and cell tags are checked: a misplaced quote in another tag can only hide tags from the reader.
    if (tag === 'row') {
      const refs = referencesAt(xml, index)
      grid.rows = Math.max(grid.rows + 1, ...refs.map(rowNumber))
      grid.unnumbered += refs.length === 0 ? 1 : 0
    } else if (tag === 'c') {
      grid.cellCol = 0
      for (const ref of referencesAt(xml, index)) {
        const { row, col } = cellReference(ref)
        grid.rows = Math.max(grid.rows, row)
        grid.cellCol = Math.max(grid.cellCol, col)
      }
    } else if (tag === 'sheetData') {
      grid.sheetData += 1
    } else if (!emptyAt(xml, index)) {
      grid.cols = Math.max(grid.cols, grid.cellCol)
      grid.dataRows = grid.rows
      grid.unnumbered = 0
    }
  }
  if (grid.sheetData > 1 || grid.rows > maxRow) {
    throw unreadable()
  }
  return { rows: grid.rows, cols: grid.cols, cells: (grid.dataRows + grid.unnumbered) * grid.cols }
}

/**
 * {@link readerGrid} for each part the text reader could read as a sheet: the reader unpacks only `.xml` and
 * `.xml.rels` parts, and reads cells only after a `sheetData`.
 */
export const readerGrids = (parts: ReadonlyMap<string, Uint8Array>) =>
  [...parts].flatMap(([part, bytes]) => {
    const xml = /\.xml(?:\.rels)?$/.test(part) ? strFromU8(bytes) : ''
    return xml.includes('sheetData') ? [{ part, ...readerGrid(scannableXml(xml)) }] : []
  })
