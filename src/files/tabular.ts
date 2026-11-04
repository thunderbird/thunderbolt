/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** True when a closing quote may be followed by this character. */
const isFieldEnd = (char: string | undefined): boolean =>
  char === undefined || char === ',' || char === '\n' || char === '\r'

/**
 * Parses CSV text (RFC 4180) into rows of fields. Accepts LF, CRLF, or CR line endings,
 * a leading byte-order mark, and whitespace before an opening quote.
 *
 * @param text - CSV source text
 * @returns rows of field values, or null when the quoting is malformed (a quoted
 *   field never closed, or text after a closing quote), since that shifts fields
 */
export const parseCsv = (text: string): string[][] | null => {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const rows: string[][] = []
  // `blank` tracks "only whitespace so far" so an opening quote is detected
  // without re-trimming the growing field, which made long fields quadratic.
  const state = { row: [] as string[], field: '', quoted: false, blank: true }

  const endField = () => {
    state.row.push(state.field)
    state.field = ''
    state.blank = true
  }
  const endRow = () => {
    endField()
    rows.push(state.row)
    state.row = []
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (state.quoted) {
      if (char === '"' && source[i + 1] === '"') {
        state.field += '"'
        i++
      } else if (char === '"') {
        if (!isFieldEnd(source[i + 1])) {
          return null
        }
        state.quoted = false
      } else {
        state.field += char
      }
    } else if (char === '"' && state.blank) {
      state.field = ''
      state.quoted = true
      state.blank = false
    } else if (char === ',') {
      endField()
    } else if (char === '\n') {
      endRow()
    } else if (char === '\r') {
      endRow()
      if (source[i + 1] === '\n') {
        i++
      }
    } else {
      state.field += char
      state.blank &&= /\s/.test(char)
    }
  }
  if (state.quoted) {
    return null
  }
  if (state.field !== '' || state.row.length > 0) {
    endRow()
  }
  return rows
}

/**
 * Renders rows as newline-terminated TSV. Tabs and line breaks inside a field
 * become spaces, so each line is one row and `awk -F'\t'` sees the original columns.
 */
export const toTsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((row) => `${row.map((field) => field.replace(/[\t\r\n]+/g, ' ')).join('\t')}\n`).join('')

/** Converts CSV to TSV, or null when it can't be done faithfully (empty, other delimiter, malformed quoting, ragged rows). */
export const csvToTsv = (text: string): string | null => {
  const header = text.split(/\r\n?|\n/, 1)[0].replace(/"[^"]*"/g, '')
  const count = (delimiter: string) => header.split(delimiter).length - 1
  const commaFloor = Math.max(count(','), 1)
  if (count(';') >= commaFloor || count('\t') >= commaFloor) {
    return null
  }
  const parsed = parseCsv(text)
  // A blank line is an empty cell in a one-column file, and a spacer elsewhere.
  const rows = parsed?.filter((row) => parsed[0].length === 1 || row.length > 1 || row[0] !== '')
  if (!rows?.length || rows.some((row) => row.length !== rows[0].length)) {
    return null
  }
  return toTsv(rows)
}
