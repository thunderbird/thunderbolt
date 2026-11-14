/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strToU8, zipSync } from 'fflate'

/** A cell of {@link workbook}: text, a number, a date, or nothing. Text must not hold `&` or `<`. */
export type WorkbookCell = string | number | Date | null

/** The rows of one sheet. An empty row is left out of the sheet, as Excel leaves it. */
export type WorkbookRows = readonly (readonly WorkbookCell[])[]

/** `A` for column 0, `AX` for column 49. */
const columnName = (index: number): string =>
  `${index < 26 ? '' : columnName(Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`

const excelEpoch = Date.UTC(1899, 11, 30)
const dayMs = 86_400_000

const cellXml = (value: WorkbookCell, ref: string): string => {
  if (value === null) {
    return ''
  }
  if (value instanceof Date) {
    // Style 1 is the built-in date-and-time format, so the reader returns a Date.
    return `<c r="${ref}" s="1"><v>${(value.getTime() - excelEpoch) / dayMs}</v></c>`
  }
  if (Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`
}

const sheetXml = (rows: WorkbookRows): string => {
  const sheetData = rows
    .map((cells, row) =>
      cells.length === 0
        ? ''
        : `<row r="${row + 1}">${cells.map((value, column) => cellXml(value, `${columnName(column)}${row + 1}`)).join('')}</row>`,
    )
    .join('')
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`
}

/**
 * A workbook with one sheet per argument, named `Sheet1`, `Sheet2`…, deflated as Excel saves it. The sheets are the
 * zip's last entries, which the size tests in `xlsx-to-text.browser.test.ts` rewrite.
 */
export const workbook = (...sheets: readonly WorkbookRows[]): Uint8Array<ArrayBuffer> => {
  const numbers = sheets.map((_, index) => index + 1)
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        numbers
          .map(
            (n) =>
              `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        numbers.map((n) => `<sheet name="Sheet${n}" sheetId="${n}" r:id="rId${n}"/>`).join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        numbers
          .map(
            (n) =>
              `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`,
          )
          .join('') +
        '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="22" applyNumberFormat="1"/></cellXfs></styleSheet>',
    ),
    ...Object.fromEntries(
      sheets.map((rows, index) => [`xl/worksheets/sheet${index + 1}.xml`, strToU8(sheetXml(rows))]),
    ),
  })
}
