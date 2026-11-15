/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@ironcalc/wasm'
import { strFromU8, strToU8 } from 'fflate'
import type { ExcelizeFile } from './excelize-engine'

/** A formula the app could not compute. Its cell keeps the result it had, if it had one. */
export type FormulaError = { sheet: string; cell: string; formula: string; error: string }

/** A workbook's zip entries by path, as `fflate.unzipSync` returns them. */
export type WorkbookParts = Record<string, Uint8Array>

/**
 * A pattern for an element: its tag, its attribute text and its content. Sheet parts can hold hundreds of thousands
 * of cells, too many for a DOM, so they are scanned with patterns. Element names may carry a namespace prefix
 * (`x:c`), which some generators write.
 */
const element = (name: string, flags = '') =>
  new RegExp(`<((?:[\\w.-]+:)?${name})\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1>)`, flags)

/** The value of attribute `name` (a pattern) in an element's attribute text, or `undefined` when it has none. */
const attribute = (attributes: string, name: string) =>
  new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
    .exec(attributes)
    ?.slice(1)
    .find((v) => v !== undefined)

/** `r:id`, whatever prefix the relationships namespace has. */
const relationshipId = (attributes: string) => attribute(attributes, '[\\w.-]+:id')

const entities = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
])

/** Text with its XML character and entity references resolved. */
export const decodeXml = (text: string) =>
  text.replace(/&(?:#x([\da-f]+)|#(\d+)|(\w+));/gi, (match, hex?: string, decimal?: string, name?: string) => {
    if (hex) {
      return String.fromCodePoint(parseInt(hex, 16))
    }
    return decimal ? String.fromCodePoint(Number(decimal)) : (entities.get(name ?? '') ?? match)
  })

/** Cell text: XML entities, then the `_xHHHH_` escapes OOXML uses for control characters. */
const decodeText = (text: string) =>
  decodeXml(text).replace(/_x([\da-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))

/** The reverse of `decodeText`: control characters, which XML cannot hold, become `_xHHHH_`. */
const escapeText = (text: string) =>
  text
    .replace(/_(?=x[\da-f]{4}_)/gi, '_x005F_')
    // What XML forbids: everything below a space except tab, line feed and carriage return, and U+FFFE and U+FFFF.
    .replace(/[^\t\n\r -\ufffd]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** The text of a shared or inline string, without its phonetic runs. */
const richText = (xml: string) =>
  [...xml.replace(element('rPh', 'g'), '').matchAll(element('t', 'g'))]
    .map(([, , , text = '']) => decodeText(text))
    .join('')

/**
 * The path of the part a relationship points to. `from` is the path of the part that holds the relationship, such as
 * `xl/workbook.xml`, and `target` its `Target`, relative to that part's folder unless it starts with `/`. Returns a
 * zip entry path, such as `xl/worksheets/sheet1.xml`.
 */
export const resolvePart = (from: string, target: string) => {
  if (target.startsWith('/')) {
    return target.slice(1)
  }
  const path = from.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') {
      path.pop()
    } else if (segment !== '.') {
      path.push(segment)
    }
  }
  return path.join('/')
}

/** The targets of a part's relationships, by id and by type. */
const relationshipsOf = (parts: WorkbookParts, part: string) => {
  const slash = part.lastIndexOf('/') + 1
  const rels = parts[`${part.slice(0, slash)}_rels/${part.slice(slash)}.rels`]
  return [...strFromU8(rels ?? new Uint8Array()).matchAll(element('Relationship', 'g'))].map(([, , attributes]) => ({
    id: attribute(attributes, 'Id'),
    type: attribute(attributes, 'Type') ?? '',
    target: resolvePart(part, attribute(attributes, 'Target') ?? ''),
  }))
}

/** A column's number from its letters: `A` is 1, `AA` is 27. */
export const columnNumber = (letters: string) =>
  [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)

/** A column's letters from its number: 1 is `A`, 27 is `AA`. */
export const columnName = (column: number): string =>
  column > 26
    ? columnName(Math.floor((column - 1) / 26)) + columnName(((column - 1) % 26) + 1)
    : String.fromCharCode(64 + column)

type CellXml = { row: number; column: number; tag: string; attributes: string; body: string }

/** Rebuild a sheet part cell by cell. `visit` returns a cell's new XML, or nothing to keep it. */
const mapCells = (xml: string, visit: (cell: CellXml) => string | undefined) =>
  xml.replace(element('sheetData'), (sheetData) => {
    let row = 0
    return sheetData.replace(element('row', 'g'), (rowXml, _, rowAttributes: string) => {
      row = Number(attribute(rowAttributes, 'r') ?? row + 1)
      let column = 0
      return rowXml.replace(element('c', 'g'), (cellXml, tag: string, attributes: string, body = '') => {
        const ref = attribute(attributes, 'r')
        const [, letters, digits] = /^([A-Z]+)(\d+)$/i.exec(ref ?? '') ?? []
        column = letters ? columnNumber(letters) : column + 1
        return visit({ row: digits ? Number(digits) : row, column, tag, attributes, body }) ?? cellXml
      })
    })
  })

type Sheet = { name: string; part: string }

/** The rows a sheet part hides, by number. Rows a filter hides are hidden this way too. */
const hiddenRows = (xml: string) => {
  let row = 0
  return [...xml.matchAll(/<(?:[\w.-]+:)?row\b([^>]*)>/g)].flatMap(([, attributes]) => {
    row = Number(attribute(attributes, 'r') ?? row + 1)
    return /^(1|true)$/.test(attribute(attributes, 'hidden') ?? '') ? [row] : []
  })
}

/** The workbook's worksheets in tab order, its shared strings and its defined names, read from its parts. */
const readWorkbook = (parts: WorkbookParts) => {
  const workbookPart = relationshipsOf(parts, '').find(({ type }) => type.endsWith('/officeDocument'))?.target ?? ''
  const workbookXml = strFromU8(parts[workbookPart] ?? new Uint8Array())
  const relationships = relationshipsOf(parts, workbookPart)
  const sheetTabs = [...workbookXml.matchAll(element('sheet', 'g'))].map(([, , attributes]) => ({
    name: decodeXml(attribute(attributes, 'name') ?? ''),
    rel: relationships.find(({ id }) => id === relationshipId(attributes)),
  }))
  const sheets: Sheet[] = sheetTabs.flatMap(({ name, rel }) =>
    rel?.type.endsWith('/worksheet') && parts[rel.target] ? [{ name, part: rel.target }] : [],
  )
  const sharedStringsPart = relationships.find(({ type }) => type.endsWith('/sharedStrings'))?.target
  const sharedStrings = [
    ...strFromU8(parts[sharedStringsPart ?? ''] ?? new Uint8Array()).matchAll(element('si', 'g')),
  ].map(([, , , body = '']) => richText(body))
  const definedNames = [...workbookXml.matchAll(element('definedName', 'g'))].map(([, , attributes, body = '']) => {
    const tab = attribute(attributes, 'localSheetId')
    const scope = tab === undefined ? undefined : sheets.findIndex(({ name }) => name === sheetTabs[Number(tab)]?.name)
    return { name: decodeXml(attribute(attributes, 'name') ?? ''), scope, formula: decodeXml(body) }
  })
  const workbookPr = element('workbookPr').exec(workbookXml)?.[2] ?? ''
  const date1904 = /^(1|true)$/.test(attribute(workbookPr, 'date1904') ?? '')
  return { sheets, sharedStrings, definedNames, date1904 }
}

/** What IronCalc is given for a cell that holds no formula it computes: the value, typed the way it is stored. */
const valueInput = (cell: CellXml, sharedStrings: string[]) => {
  const type = attribute(cell.attributes, 't')
  if (type === 'inlineStr') {
    return `'${richText(element('is').exec(cell.body)?.[3] ?? '')}`
  }
  const value = element('v').exec(cell.body)?.[3]
  if (value === undefined || value === '') {
    return undefined
  }
  if (type === 's') {
    return `'${sharedStrings[Number(value)] ?? ''}`
  }
  if (type === 'str') {
    return `'${decodeText(value)}`
  }
  if (type === 'b') {
    return value === '1' ? 'TRUE' : 'FALSE'
  }
  return decodeXml(value)
}

/**
 * A cell's formula, and why IronCalc does not compute it, if it does not. `readShared` returns the formula of a cell
 * that only points to a shared one; Excelize expands it with the references shifted. Array and data-table formulas
 * are not computed, because their result spans other cells. No formula is computed in a workbook that counts dates
 * from 1904, because IronCalc counts them from 1900.
 */
const formulaOf = (cell: CellXml, readShared: () => string, date1904: boolean) => {
  const f = element('f').exec(cell.body)
  if (!f) {
    return undefined
  }
  const type = attribute(f[2], 't') ?? 'normal'
  const text = type === 'shared' && !f[3] ? readShared() : decodeXml(f[3] ?? '')
  // A data-table formula has no text, so the type is checked first.
  if (type !== 'normal' && type !== 'shared') {
    return {
      text,
      notComputed:
        'an array or data-table formula, which is not computed; formulas that read its cells use the values saved in them',
    }
  }
  if (text === '') {
    return undefined
  }
  return { text, notComputed: date1904 ? 'the workbook counts dates from 1904, so no formula is computed' : undefined }
}

type Result = { type?: 'str' | 'b'; value: string } | { error: string }

// IronCalc 0.9 has no call that returns a raw number, so a result is formatted to 15 significant digits, as many
// as Excel shows, and parsed back.
const fullPrecision = '0.00000000000000E+00'

const resultOf = (model: Model, sheet: number, row: number, column: number): Result => {
  // One cell at a time: styling a range costs its area, which a formula far from the others makes huge.
  model.updateRangeStyle({ sheet, row, column, width: 1, height: 1 }, 'num_fmt', fullPrecision)
  const text = model.getFormattedCellValue(sheet, row, column)
  switch (model.getCellType(sheet, row, column)) {
    case 1: {
      const number = Number(text)
      return Number.isFinite(number) ? { value: String(number) } : { error: '#NUM!' }
    }
    case 2:
      return { type: 'str', value: text }
    case 4:
      return { type: 'b', value: text === 'TRUE' ? '1' : '0' }
    default:
      return { error: text }
  }
}

type Formula = { sheet: number; row: number; column: number; formula: string }

/**
 * Compute every formula of a workbook Excelize saved and store each result in `parts` as the cell's cached value,
 * typed as a number, text or boolean, so a viewer that does not calculate still shows it. Excelize saves a formula
 * with no result and marks it as text. A formula IronCalc cannot compute, or that `formulaOf` leaves out, keeps
 * the cell as it was and is returned with its cell. Only sheet parts change.
 */
export const cacheFormulaResults = (file: ExcelizeFile, parts: WorkbookParts, ironcalc: typeof Model) => {
  const { sheets, sharedStrings, definedNames, date1904 } = readWorkbook(parts)
  const errors: FormulaError[] = []
  const model = new ironcalc('workbook', 'en', Intl.DateTimeFormat().resolvedOptions().timeZone, 'en')
  try {
    model.pauseEvaluation()
    sheets.forEach(({ name }, index) => {
      if (index > 0) {
        model.newSheet()
      }
      model.renameSheet(index, name)
    })
    for (const { name, scope, formula } of definedNames) {
      try {
        model.newDefinedName(name, scope, formula)
      } catch {
        // A name IronCalc cannot hold: formulas that use it fail and are reported.
      }
    }
    const formulas: Formula[] = []
    sheets.forEach((sheet, index) => {
      const xml = strFromU8(parts[sheet.part])
      // SUBTOTAL and AGGREGATE leave hidden rows out.
      for (const row of hiddenRows(xml)) {
        model.setRowsHidden(index, row, row, true)
      }
      mapCells(xml, (cell) => {
        const cellName = `${columnName(cell.column)}${cell.row}`
        const formula = formulaOf(cell, () => file.GetCellFormula(sheet.name, cellName).formula, date1904)
        if (formula?.notComputed) {
          errors.push({ sheet: sheet.name, cell: cellName, formula: formula.text, error: formula.notComputed })
        }
        const computed = formula !== undefined && formula.notComputed === undefined
        const input = computed ? `=${formula.text}` : valueInput(cell, sharedStrings)
        if (input === undefined) {
          return undefined
        }
        try {
          model.setUserInput(index, cell.row, cell.column, input)
          if (computed) {
            formulas.push({ sheet: index, row: cell.row, column: cell.column, formula: formula.text })
          }
        } catch (error) {
          errors.push({ sheet: sheet.name, cell: cellName, formula: formula?.text ?? '', error: String(error) })
        }
        return undefined
      })
    })
    model.evaluate()
    const results = new Map<string, Result>()
    for (const { sheet, row, column, formula } of formulas) {
      const result = resultOf(model, sheet, row, column)
      results.set(`${sheet}:${row}:${column}`, result)
      if ('error' in result) {
        errors.push({ sheet: sheets[sheet].name, cell: `${columnName(column)}${row}`, formula, error: result.error })
      }
    }
    sheets.forEach(({ part }, index) => {
      const xml = strFromU8(parts[part])
      const updated = mapCells(xml, ({ row, column, tag, attributes, body }) => {
        const result = results.get(`${index}:${row}:${column}`)
        if (!result || 'error' in result) {
          return undefined
        }
        const prefix = tag.slice(0, -1)
        const formula = element('f').exec(body)?.[0] ?? ''
        const rest = body.replace(formula, '').replace(element('v', 'g'), '').replace(element('is', 'g'), '')
        const type = result.type ? ` t="${result.type}"` : ''
        return `<${tag}${attributes.replace(/\st\s*=\s*(?:"[^"]*"|'[^']*')/, '')}${type}>${formula}<${prefix}v>${escapeText(result.value)}</${prefix}v>${rest}</${tag}>`
      })
      if (updated !== xml) {
        parts[part] = strToU8(updated)
      }
    })
  } finally {
    model.free()
  }
  return errors
}
