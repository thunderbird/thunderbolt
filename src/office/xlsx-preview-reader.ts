/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Font, Style } from 'excelize-wasm'
import { strFromU8, unzipSync } from 'fflate'
import { sandboxLimits, xlsxPreviewLimits } from './constants'
import type { Excelize, ExcelizeEngine } from './excelize-engine'
import { columnName, columnNumber, decodeXml, type WorkbookParts } from './formula-cache'
import {
  type Anchor,
  type ChartKind,
  drawingObjects,
  type DrawingObject,
  expandPoints,
  type PlaceholderKind,
  type SeriesData,
  type Stacking,
  withoutComments,
  workbookParts,
} from './xlsx-drawings'
import { WorkbookTooLargeError } from './xlsx-preview-client'

export type PreviewLimits = typeof xlsxPreviewLimits

/** Where Excel's General alignment puts a value that is not text: numbers and dates at the end, the rest centred. */
type CellAlign = 'end' | 'center'

/** A cell with a value or a style: its text in its number format, cut to the cell limit, and its style index. */
export type PreviewCell = { col: number; text: string; style: number; align?: CellAlign; link?: true }

type PreviewRow = { row: number; cells: PreviewCell[] }

/** Rows read for the grid, and the styles they use that no earlier read sent. */
export type RowsRead = { rows: PreviewRow[]; styles: [number, Style][] }

/** A position and size in pixels, from the top-left corner of cell A1. */
type Box = { x: number; y: number; width: number; height: number }

type ChartSeriesValues = { name: string; values: number[] }

export type Overlay = Box &
  (
    | {
        type: 'chart'
        kind: ChartKind
        stacking: Stacking
        title: string
        categories: string[]
        series: ChartSeriesValues[]
      }
    | { type: 'placeholder'; kind: ChartKind | PlaceholderKind; title: string }
    | { type: 'image'; bytes: Uint8Array; alt: string }
  )

/** A chart or picture as the grid gets it, whether a cap cut part of its data, and how many values it draws. */
type PlacedOverlay = { overlay: Overlay; cut: boolean; points: number }

/** The values a sheet's charts may still draw, whether a chart had to drop any, and the series read so far. */
type ChartBudget = { left: number; cut: boolean; series: ChartSeriesValues[] }

/** The overlays placed on a sheet so far, and the values its charts may still draw. */
type SheetOverlays = { left: number; placed: PlacedOverlay[] }

/** A merged range: its top-left cell, zero-based, and how many rows and columns it spans. */
export type Merge = { row: number; col: number; rows: number; cols: number }

/** What the grid draws of one sheet. Row and column numbers are zero-based; hidden ones are left out of the lists. */
export type SheetLayout = {
  rows: number[]
  cols: number[]
  /** In pixels, by row and column number, up to the last one the grid reaches. */
  rowHeights: number[]
  colWidths: number[]
  /** How many of the shown rows and columns are frozen. */
  frozenRows: number
  frozenCols: number
  merges: Merge[]
  overlays: Overlay[]
  /** Charts and pictures left out, or drawn with only part of their data, by the caps. */
  leftOutObjects: number
  rtl: boolean
}

/** A visible worksheet and the size of the range that holds its cells. A sheet marked `tooLarge` is never opened. */
type SheetSummary = { name: string; rows: number; cols: number; tooLarge: boolean }

/** What the preview leaves out of the whole workbook. */
type LeftOut = {
  hiddenSheets: number
  chartSheets: number
  conditionalFormats: boolean
  missingResults: number
  unsupportedCharts: number
  /** Shapes, text boxes and connectors. */
  drawings: boolean
  sparklines: boolean
  longText: boolean
}

export type WorkbookOverview = { sheets: SheetSummary[]; leftOut: LeftOut }

/** An open workbook as the preview reads it. `index` is a sheet's place among the visible ones. */
export type PreviewWorkbook = {
  overview: WorkbookOverview
  sheet: (index: number) => SheetLayout
  /** The shown rows numbered from `from` up to, not including, `to`. */
  rows: (index: number, from: number, to: number) => RowsRead
}

/** The calls the preview Worker answers: `open` first, then `sheet` and `rows` on the workbook it opened. */
export type PreviewCalls = {
  open: (bytes: Uint8Array) => WorkbookOverview
  sheet: PreviewWorkbook['sheet']
  rows: PreviewWorkbook['rows']
}

const emuPerPixel = 9525
const defaultRowPixels = 20
const defaultColumnPixels = 64
const defaultFontPoints = 11
// Excel's default 15-point row holds its 11-point font: a row sized to a font is about 1.3 times the font.
const lineHeight = 1.3
// Excel's own maximums: a 409-point row and a 255-character column.
const maxRowPixels = 545
const maxColumnPixels = 1785
/** The most charts and pictures one sheet draws. */
const maxOverlays = 50

/** Excelize reports a failure in the result's `error`; here it becomes a thrown Error. */
export const settle = <T extends { error?: string | null }>(result: T): T => {
  if (result.error) {
    throw new Error(result.error)
  }
  return result
}

const range = (length: number) => Array.from({ length }, (_, i) => i)

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value))

// Each pattern stops at the next `<`, so a scan stays linear on any input. Attribute values may use single or double
// quotes, as XML allows.
const sheetTagPattern = /<(?:[\w.-]+:)?(row|c)\b([^<>]*)>/g

const attributePattern = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)

const refAttribute = attributePattern('r')
const styleAttribute = attributePattern('s')
const heightAttribute = attributePattern('ht')

const readAttribute = (attributes: string, pattern: RegExp) => {
  const match = pattern.exec(attributes)
  return match ? (match[1] ?? match[2]) : undefined
}

/**
 * Visit a sheet part's row and cell tags in order, numbering those written without an `r` as Excel does: a row after
 * the last, a cell after the one before it. Either callback returns false to stop.
 */
const visitSheet = (
  xml: string,
  onRow: (row: number, attributes: string) => boolean,
  onCell: (row: number, col: number, attributes: string) => boolean,
) => {
  const position = { row: 0, col: 0 }
  for (const [, tag, attributes] of xml.matchAll(sheetTagPattern)) {
    if (tag === 'row') {
      position.row = Number(readAttribute(attributes, refAttribute)) || position.row + 1
      position.col = 0
      if (!onRow(position.row, attributes)) {
        return
      }
      continue
    }
    const [, letters, digits] = /^([A-Z]{1,3})(\d+)$/.exec(readAttribute(attributes, refAttribute) ?? '') ?? []
    position.col = letters ? columnNumber(letters) : position.col + 1
    if (!onCell(digits ? Number(digits) : position.row, position.col, attributes)) {
      return
    }
  }
}

/**
 * The rows and columns a sheet part's cells reach, the last row it holds at all, and how many cells Excelize would
 * hold for it. Excelize fills each row out to its last cell and the sheet out to its last row, so one cell at XFD
 * costs 16,384 and one row at 1,048,576 costs a million. Counting stops past `maxCells`, the size at which the sheet
 * is not read.
 */
const scanCells = (xml: string, maxCells: number) => {
  const size = { rows: 0, cols: 0, lastRow: 0, filled: 0, rowEnd: 0 }
  const cells = () => size.lastRow + size.filled + size.rowEnd
  visitSheet(
    xml,
    (row) => {
      size.filled += size.rowEnd
      size.rowEnd = 0
      size.lastRow = Math.max(size.lastRow, row)
      return cells() <= maxCells
    },
    (row, col) => {
      size.rowEnd = Math.max(size.rowEnd, col)
      size.lastRow = Math.max(size.lastRow, row)
      size.rows = Math.max(size.rows, row)
      size.cols = Math.max(size.cols, col)
      return cells() <= maxCells
    },
  )
  return { rows: size.rows, cols: size.cols, lastRow: size.lastRow, cells: cells() }
}

/**
 * The `sheetData` element of a sheet part, where its cells are: extensions after it hold formulas of their own. A
 * self-closing one holds nothing.
 */
const sheetDataOf = (xml: string) => {
  const open = /<(?:[\w.-]+:)?sheetData\b[^<>]*>/.exec(xml)
  if (!open || open[0].endsWith('/>')) {
    return ''
  }
  const end = xml.search(/<\/(?:[\w.-]+:)?sheetData>/)
  return xml.slice(open.index, end === -1 ? undefined : end)
}

/** Formulas saved with no result: a cell's `<f>` that no `<v>` follows. An empty `<v/>` is a saved empty text. */
const missingResults = (xml: string) =>
  sheetDataOf(xml).match(/<(?:[\w.-]+:)?f\b[^<>]*?(?:\/>|>[^<]*<\/(?:[\w.-]+:)?f>)(?!\s*<(?:[\w.-]+:)?v\b)/g)?.length ??
  0

const countMerges = (xml: string) => xml.match(/<(?:[\w.-]+:)?mergeCell\b/g)?.length ?? 0

const hasElement = (xml: string, name: string) => new RegExp(`<(?:[\\w.-]+:)?${name}\\b`).test(xml)

/** True when an inline string or a saved result in a sheet part is longer than `limit` characters. */
const hasLongText = (xml: string, limit: number) =>
  [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?[tv]\\b[^<>]*>([^<]{${limit + 1},})<`, 'g'))].some(
    ([, text]) => decodeXml(text).length > limit,
  )

/**
 * The largest font size in each row with no stored height, by zero-based row: Excel sizes such a row to its largest
 * font, and Excelize saves none. Not handled: wrapped text does not grow a row. Measure the text if sheets with
 * wrapped text need taller rows.
 */
const largestFonts = (xml: string, fontSize: (style: number) => number) => {
  const largest = new Map<number, number>()
  const row = { sized: false }
  visitSheet(
    xml,
    (_, attributes) => {
      row.sized = readAttribute(attributes, heightAttribute) !== undefined
      return true
    },
    (cellRow, _, attributes) => {
      const style = readAttribute(attributes, styleAttribute)
      if (!row.sized && style !== undefined) {
        largest.set(cellRow - 1, Math.max(largest.get(cellRow - 1) ?? 0, fontSize(Number(style))))
      }
      return true
    },
  )
  return largest
}

/**
 * Unzip under a ceiling, counting each entry at the larger of its packed and declared size. Parts are named with `/`
 * as Excelize names them; two entries for one part are refused, since Excelize could read the other one.
 */
const unzipBounded = (bytes: Uint8Array, limit: number): WorkbookParts => {
  let total = 0
  const names = new Set<string>()
  const entries = unzipSync(bytes, {
    filter: ({ name, size, originalSize }) => {
      total += Math.max(size, originalSize)
      if (total > limit) {
        throw new WorkbookTooLargeError(`The workbook unzips to more than ${limit} bytes.`)
      }
      const part = name.replaceAll('\\', '/')
      if (names.has(part)) {
        throw new Error(`The workbook holds ${part} twice.`)
      }
      names.add(part)
      // A part by this name would replace the prototype of the parts object.
      return name !== '__proto__'
    },
  })
  return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name.replaceAll('\\', '/'), data]))
}

/** What the parts unzip to, leaving out pictures: Excelize parses any part a workbook relationship names. */
const parsedBytes = (parts: WorkbookParts, workbookTargets: string[]) => {
  const named = new Set(workbookTargets)
  return Object.entries(parts)
    .filter(([name]) => !name.startsWith('xl/media/') || named.has(name))
    .reduce((total, [, data]) => total + data.length, 0)
}

const referencePattern = /^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/

/** A range a chart reads, such as `'My sheet'!$A$2:$A$7`. A defined name or a list of ranges gives `undefined`. */
const parseReference = (ref: string) => {
  const [, quoted, plain, fromCol, fromRow, toCol = fromCol, toRow = fromRow] = referencePattern.exec(ref.trim()) ?? []
  if (!fromCol) {
    return undefined
  }
  return {
    sheet: quoted?.replaceAll("''", "'") ?? plain,
    cols: [columnNumber(fromCol), columnNumber(toCol)],
    rows: [Number(fromRow), Number(toRow)],
  }
}

/**
 * The pixel edge before column or row `index`: the sizes of the shown ones before it, then a default size for each
 * past the grid. An anchor's index comes from the file, so it is never counted one by one.
 */
const edgeOf = (sizes: number[], shown: Set<number>, fallback: number) => (index: number) =>
  sizes.slice(0, index).reduce((edge, size, i) => edge + (shown.has(i) ? size : 0), 0) +
  Math.max(0, index - sizes.length) * fallback

/** Where an anchor puts its object, in pixels. */
const boxOf = (anchor: Anchor, left: (col: number) => number, top: (row: number) => number): Box => {
  const { from, to, size } = anchor
  const x = left(from.col) + from.colOff / emuPerPixel
  const y = top(from.row) + from.rowOff / emuPerPixel
  const right = to ? left(to.col) + to.colOff / emuPerPixel : x + (size?.cx ?? 0) / emuPerPixel
  const bottom = to ? top(to.row) + to.rowOff / emuPerPixel : y + (size?.cy ?? 0) / emuPerPixel
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

/** The last row and column an object reaches, zero-based, estimated from its size when it has no second corner. */
const anchorEnd = ({ from, to, size }: Anchor) => ({
  row: to?.row ?? from.row + Math.ceil((size?.cy ?? 0) / emuPerPixel / defaultRowPixels),
  col: to?.col ?? from.col + Math.ceil((size?.cx ?? 0) / emuPerPixel / defaultColumnPixels),
})

/**
 * Open a workbook for the spreadsheet preview, in its Worker. Excelize reads values in their number formats, styles,
 * sizes, merges and panes; the zip is read for what Excelize cannot report: charts, pictures, shapes, conditional
 * formats, sparklines and formulas with no saved result. Excelize parses a whole sheet on first use, but one cell
 * after that is cheap, so cells are read in chunks of the rows the grid shows.
 */
export const openPreviewWorkbook = (
  excelize: Excelize,
  bytes: Uint8Array,
  limits: PreviewLimits = xlsxPreviewLimits,
): PreviewWorkbook => {
  // Everything Excelize could parse is measured before it opens the file: whichever part it picks, none is larger.
  const parts = unzipBounded(bytes, limits.unzipBytes)
  const workbook = workbookParts(parts)
  const total = parsedBytes(parts, workbook.targets)
  if (total > limits.partBytes) {
    throw new WorkbookTooLargeError(`The workbook's parts unzip to ${total} bytes, more than the preview reads.`)
  }
  const file = settle(
    excelize.OpenReader(bytes, { UnzipSizeLimit: limits.unzipBytes, UnzipXMLSizeLimit: limits.unzipBytes }),
  )
  const { list } = file.GetSheetList()
  if (list.length !== workbook.names.length || list.some((name, i) => name !== workbook.names[i])) {
    throw new Error('Excelize reads other sheets than the workbook lists.')
  }
  const sharedStrings = parts[workbook.sharedStrings ?? ''] ?? new Uint8Array()
  // Twice the cells the grid shows: more than that cost more memory than the preview has.
  const maxCells = 2 * limits.rows * limits.columns
  // Every worksheet, hidden ones too, since a chart can read any of them.
  const scans = workbook.sheets.map(({ name, part }) => {
    const visible = file.GetSheetVisible(name).visible
    // Every scan of the part below reads it without its comments: a tag inside one is no tag to Excelize.
    const xml = withoutComments(strFromU8(parts[part]))
    const { cells, ...size } = scanCells(xml, maxCells)
    const tooMany = cells > maxCells || countMerges(xml) > limits.merges
    const objects = visible && !tooMany ? drawingObjects(parts, part) : []
    return {
      visible,
      sheet: { name, part, ...size, tooLarge: tooMany || !objects, objects: objects ?? [] },
      conditionalFormats: hasElement(xml, 'conditionalFormatting'),
      sparklines: hasElement(xml, 'sparklineGroup'),
      missingResults: missingResults(xml),
      longText: hasLongText(xml, limits.cellChars),
    }
  })
  const shown = scans.filter(({ visible }) => visible)
  const sheets = shown.map(({ sheet }) => sheet)
  // Excelize names sheets case-insensitively; a chart may read only a sheet scanned and small enough.
  const readable = new Map(scans.map(({ sheet }) => [sheet.name.toLowerCase(), !sheet.tooLarge]))
  const layouts = new Map<number, SheetLayout>()
  const links = new Map<number, Set<string>>()
  // Style indexes whose styles the main thread already has.
  const sentStyles = new Set<number>()
  const fontSizes = new Map<number, number>()
  const rangeValues = new Map<string, string[]>()

  /** A style's font size in points, read once per style. A style the file does not define has the default. */
  const fontSizeOf = (id: number) => {
    const known = fontSizes.get(id)
    if (known !== undefined) {
      return known
    }
    const { style, error } = file.GetStyle(id)
    const size = (!error && style.Font?.Size) || defaultFontPoints
    fontSizes.set(id, size)
    return size
  }

  /** The colour a font's theme or indexed colour stands for, when it has no RGB one. */
  const baseColorOf = (theme: number | undefined, indexed: number | undefined) => {
    if (theme !== undefined) {
      return settle(file.GetBaseColor('', 0, theme)).color
    }
    return indexed ? settle(file.GetBaseColor('', indexed)).color : undefined
  }

  /**
   * A font's colour as hex, its tint applied whatever the base colour. Excelize resolves fill and border colours
   * from the theme part, but leaves a font's theme or indexed colour and its tint. Not handled: a workbook with no
   * theme part loses its fill and border colours, RGB ones too. Read the xf's colours from `xl/styles.xml` if such
   * workbooks need them.
   */
  const fontColorOf = ({ Color: color, ColorTheme: theme, ColorIndexed: indexed, ColorTint: tint }: Font) => {
    const base = color || baseColorOf(theme, indexed)
    return base && tint ? settle(excelize.ThemeColor(base, tint)).color : base
  }

  const clip = (text: string) => (text.length > limits.cellChars ? `${text.slice(0, limits.cellChars)}…` : text)

  /**
   * At most `count` cells of a range, as text in their number formats or as raw values, each range read once. A range
   * on a sheet too large, or on none scanned, is refused: Excelize would parse that whole sheet to read it.
   */
  const readRange = (ref: string | undefined, raw: boolean, count: number) => {
    const parsed = ref ? parseReference(ref) : undefined
    if (!parsed) {
      return []
    }
    if (readable.get(parsed.sheet.toLowerCase()) !== true) {
      throw new WorkbookTooLargeError(`A chart reads ${parsed.sheet}, a sheet the preview does not read.`)
    }
    const [firstRow, lastRow] = parsed.rows
    const [firstCol, lastCol] = parsed.cols
    const width = lastCol - firstCol + 1
    // Counted before any cell is named: a whole-column range such as `A:XFD` would otherwise name billions.
    const cells = Math.min((lastRow - firstRow + 1) * width, count)
    const key = `${raw}|${cells}|${ref}`
    const known = rangeValues.get(key)
    if (known) {
      return known
    }
    const values = range(cells).map((i) => {
      const cell = `${columnName(firstCol + (i % width))}${firstRow + Math.floor(i / width)}`
      return settle(file.GetCellValue(parsed.sheet, cell, { RawCellValue: raw })).value ?? ''
    })
    rangeValues.set(key, values)
    return values
  }

  /** The chart's saved values when it saved some; otherwise the range it reads. At most `count` of them. */
  const valuesOf = (data: SeriesData, raw: boolean, count: number) =>
    data.cache ? expandPoints(data.cache, count) : readRange(data.ref, raw, count)

  /** A value as a chart draws it: one that is not a finite number, `Infinity` included, draws as zero. */
  const chartNumber = (value: string) => {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
  }

  /**
   * A chart drawing at most `left` values across its series, whether that cut any, and how many it draws. One with
   * none left, or whose ranges cannot be read, becomes a placeholder rather than a chart of zeros.
   */
  const chartOf = (object: Extract<DrawingObject, { type: 'chart' }>, box: Box, left: number): PlacedOverlay => {
    const { kind, stacking, title } = object
    const placeholder = { ...box, type: 'placeholder', kind, title } satisfies Overlay
    if (left <= 0) {
      return { overlay: placeholder, cut: true, points: 0 }
    }
    try {
      const drawn: ChartBudget = { left, cut: false, series: [] }
      for (const { name, values } of object.series) {
        if (drawn.left <= 0) {
          drawn.cut = true
          break
        }
        const read = valuesOf(values, true, drawn.left + 1)
        const kept = read.slice(0, drawn.left).map(chartNumber)
        // An empty series still costs one: each draws a line or a legend entry.
        drawn.left -= Math.max(1, kept.length)
        drawn.cut ||= read.length > kept.length
        drawn.series.push({ name: valuesOf(name, false, 1)[0] ?? '', values: kept })
      }
      const longest = drawn.series.reduce((most, { values }) => Math.max(most, values.length), 0)
      const categories = object.series[0] ? valuesOf(object.series[0].categories, false, longest) : []
      return {
        overlay: { ...box, type: 'chart', kind, stacking, title, categories, series: drawn.series },
        cut: drawn.cut,
        points: left - drawn.left,
      }
    } catch (error) {
      console.error('[xlsx-preview] Could not read a chart', error)
      return { overlay: placeholder, cut: false, points: 0 }
    }
  }

  const overlayOf = (object: DrawingObject, box: Box, left: number): PlacedOverlay | undefined => {
    switch (object.type) {
      case 'chart':
        return chartOf(object, box, left)
      case 'placeholder':
        return {
          overlay: { ...box, type: 'placeholder', kind: object.kind, title: object.title },
          cut: false,
          points: 0,
        }
      case 'image':
        return { overlay: { ...box, type: 'image', bytes: object.bytes, alt: object.alt }, cut: false, points: 0 }
      case 'shape':
        return undefined
    }
  }

  const sheet = (index: number): SheetLayout => {
    const { name, part, rows: usedRows, cols: usedCols, lastRow, objects, tooLarge } = sheets[index]
    if (tooLarge) {
      throw new WorkbookTooLargeError(`Sheet ${name} is larger than the preview reads.`)
    }
    const ranges = settle(file.GetMergeCells(name, true)).mergeCells.flatMap((merge) => {
      const start = parseReference(`x!${merge.GetStartAxis()}`)
      const end = parseReference(`x!${merge.GetEndAxis()}`)
      return start && end
        ? [{ row: start.rows[0] - 1, col: start.cols[0] - 1, end: { row: end.rows[0] - 1, col: end.cols[0] - 1 } }]
        : []
    })
    const ends = [...objects.map(({ anchor }) => anchorEnd(anchor)), ...ranges.map(({ end }) => end)]
    // Like Excel, the grid goes on a little past the cells, and far enough to hold every chart, picture and merge.
    const rowCount = Math.min(
      ends.reduce((most, { row }) => Math.max(most, row + 1), Math.max(usedRows + 5, 30)),
      limits.rows,
    )
    const colCount = Math.min(
      ends.reduce((most, { col }) => Math.max(most, col + 1), Math.max(usedCols + 1, 10)),
      limits.columns,
    )
    const fonts = largestFonts(withoutComments(strFromU8(parts[part])), fontSizeOf)
    const rowHeights = range(rowCount).map((r) => {
      const stored = Math.round((settle(file.GetRowHeight(name, r + 1)).height * 4) / 3)
      const font = fonts.get(r)
      const height = font ? Math.max(stored, Math.ceil(((font * 4) / 3) * lineHeight)) : stored
      return clamp(height, maxRowPixels)
    })
    // Excelize reports a row past the last one it holds as hidden; a row the file holds, cells or none, says itself.
    const rows = range(rowCount).filter((r) => r >= lastRow || file.GetRowVisible(name, r + 1).visible)
    const colWidths = range(colCount).map((c) =>
      clamp(Math.round(settle(file.GetColWidth(name, columnName(c + 1))).width * 7), maxColumnPixels),
    )
    const cols = range(colCount).filter((c) => file.GetColVisible(name, columnName(c + 1)).visible)
    const shownRows = new Set(rows)
    const shownCols = new Set(cols)
    const { panes } = file.GetPanes(name)
    // A merge whose first cell is hidden draws as separate cells: nothing would show its text or take the focus.
    // Valid merges never overlap, so they cover at most the grid; overlapping ones past that are dropped.
    const merges = ranges
      .filter(({ row, col }) => shownRows.has(row) && shownCols.has(col))
      .map(({ row, col, end }) => ({
        row,
        col,
        rows: Math.min(end.row + 1, rowCount) - row,
        cols: Math.min(end.col + 1, colCount) - col,
      }))
      .reduce<{ area: number; kept: Merge[] }>(
        ({ area, kept }, merge) =>
          area + merge.rows * merge.cols > rowCount * colCount
            ? { area, kept }
            : { area: area + merge.rows * merge.cols, kept: [...kept, merge] },
        { area: 0, kept: [] },
      ).kept
    const left = edgeOf(colWidths, shownCols, defaultColumnPixels)
    const top = edgeOf(rowHeights, shownRows, defaultRowPixels)
    const [gridWidth, gridHeight] = [left(colCount), top(rowCount)]
    // Charts and pictures past the last row or column shown, or past the most one sheet draws, are counted as left
    // out. The sheet's charts share one budget of values.
    const drawable = objects.filter(({ type }) => type !== 'shape')
    const { placed } = drawable
      .filter(({ anchor }) => anchor.from.row < rowCount && anchor.from.col < colCount)
      .slice(0, maxOverlays)
      .reduce<SheetOverlays>(
        (sheetOverlays, object) => {
          const box = boxOf(object.anchor, left, top)
          const overlay =
            box.y < gridHeight && box.x < gridWidth ? overlayOf(object, box, sheetOverlays.left) : undefined
          return overlay
            ? { left: sheetOverlays.left - overlay.points, placed: [...sheetOverlays.placed, overlay] }
            : sheetOverlays
        },
        { left: limits.chartPoints, placed: [] },
      )
    const layout = {
      rows,
      cols,
      rowHeights,
      colWidths,
      frozenRows: panes.Freeze ? rows.filter((r) => r < (panes.YSplit ?? 0)).length : 0,
      frozenCols: panes.Freeze ? cols.filter((c) => c < (panes.XSplit ?? 0)).length : 0,
      merges,
      overlays: placed.map(({ overlay }) => overlay),
      leftOutObjects: drawable.length - placed.length + placed.filter(({ cut }) => cut).length,
      rtl: file.GetSheetView(name, -1).opts?.RightToLeft ?? false,
    } satisfies SheetLayout
    layouts.set(index, layout)
    links.set(index, new Set(file.GetHyperLinkCells(name, '').result))
    return layout
  }

  const alignOf = (cellType: number): CellAlign | undefined => {
    if ([excelize.CellTypeUnset, excelize.CellTypeNumber, excelize.CellTypeDate].includes(cellType)) {
      return 'end'
    }
    return [excelize.CellTypeBool, excelize.CellTypeError].includes(cellType) ? 'center' : undefined
  }

  /**
   * The shown rows from `from` up to `to`, each shown column of each. Past the last cell too: a style the file sets on
   * a whole row or column, which `GetCellStyle` resolves for an empty cell, draws there.
   */
  const rows = (index: number, from: number, to: number): RowsRead => {
    const { name } = sheets[index]
    const layout = layouts.get(index) ?? sheet(index)
    const linked = links.get(index) ?? new Set()
    const styleIds = new Set<number>()
    const cellsOf = (row: number) =>
      layout.cols.flatMap((col): PreviewCell[] => {
        const ref = `${columnName(col + 1)}${row + 1}`
        const text = settle(file.GetCellValue(name, ref)).value ?? ''
        const { style } = settle(file.GetCellStyle(name, ref))
        if (!text && !style) {
          return []
        }
        styleIds.add(style)
        const align = text ? alignOf(settle(file.GetCellType(name, ref)).cellType) : undefined
        return [{ col, text: clip(text), style, align, link: linked.has(ref) || undefined }]
      })
    const read = layout.rows.filter((row) => row >= from && row < to).map((row) => ({ row, cells: cellsOf(row) }))
    const styles = [...styleIds]
      .filter((id) => !sentStyles.has(id))
      .map((id): [number, Style] => {
        sentStyles.add(id)
        const read = file.GetStyle(id)
        // A workbook with no styles part, which some writers leave out, has no style 0 either: it draws plain.
        if (id === 0 && read.error) {
          return [id, {}]
        }
        const { style } = settle(read)
        return [id, style.Font ? { ...style, Font: { ...style.Font, Color: fontColorOf(style.Font) } } : style]
      })
    return { rows: read, styles }
  }

  const objects = sheets.flatMap(({ objects: sheetObjects }) => sheetObjects)
  const overview = {
    sheets: sheets.map(({ name, rows: sheetRows, cols, tooLarge }) => ({ name, rows: sheetRows, cols, tooLarge })),
    leftOut: {
      hiddenSheets: workbook.sheets.length - shown.length,
      chartSheets: file.GetSheetList().list.length - workbook.sheets.length,
      conditionalFormats: shown.some((scan) => scan.conditionalFormats),
      missingResults: shown.reduce((sum, scan) => sum + scan.missingResults, 0),
      unsupportedCharts: objects.filter(({ type }) => type === 'placeholder').length,
      drawings: objects.some(({ type }) => type === 'shape'),
      sparklines: shown.some((scan) => scan.sparklines),
      longText:
        shown.some((scan) => scan.longText) || hasLongText(withoutComments(strFromU8(sharedStrings)), limits.cellChars),
    },
  } satisfies WorkbookOverview
  return { overview, sheet, rows }
}

type Calls = keyof PreviewCalls

/** What the host posts to the preview Worker. */
export type PreviewRequest = { [K in Calls]: { id: number; call: K; args: Parameters<PreviewCalls[K]> } }[Calls]

/** What the Worker posts back: the call's result, or why it failed. */
export type PreviewAnswer =
  | { [K in Calls]: { id: number; call: K; result: ReturnType<PreviewCalls[K]> } }[Calls]
  | { id: number; error: string; tooLarge?: true }

/** Run one request on a reader. The Worker answers with this; a test can call it in process. */
export const answerRequest = (reader: PreviewCalls, request: PreviewRequest): PreviewAnswer => {
  const { id } = request
  try {
    switch (request.call) {
      case 'open':
        return { id, call: request.call, result: reader.open(...request.args) }
      case 'sheet':
        return { id, call: request.call, result: reader.sheet(...request.args) }
      case 'rows':
        return { id, call: request.call, result: reader.rows(...request.args) }
    }
  } catch (error) {
    return error instanceof WorkbookTooLargeError
      ? { id, error: String(error), tooLarge: true }
      : { id, error: String(error) }
  }
}

/**
 * The Worker's calls over one open workbook at a time. A call after which Excelize holds more memory than the script
 * tool allows it fails, as the script tool's does: WebAssembly memory never shrinks, so the preview ends there.
 */
export const createPreviewReader = (
  { excelize, excelizeMemory }: ExcelizeEngine,
  memoryBytes = sandboxLimits.workbookMemoryBytes,
): PreviewCalls => {
  let workbook: PreviewWorkbook | undefined
  const opened = () => {
    if (!workbook) {
      throw new Error('No workbook is open.')
    }
    return workbook
  }
  const checkMemory = () => {
    if (excelizeMemory.buffer.byteLength > memoryBytes) {
      throw new WorkbookTooLargeError(`Excelize used more than ${memoryBytes} bytes of memory.`)
    }
  }
  // Past the ceiling, whatever the call threw is about size: Go's runtime dies at WebAssembly's 4 GiB and its calls
  // return nothing, which the reader meets as a TypeError.
  const withinMemory = <T>(call: () => T): T => {
    try {
      const result = call()
      checkMemory()
      return result
    } catch (error) {
      checkMemory()
      throw error
    }
  }
  return {
    open: (bytes) =>
      withinMemory(() => {
        workbook = openPreviewWorkbook(excelize, bytes)
        return workbook.overview
      }),
    sheet: (index) => withinMemory(() => opened().sheet(index)),
    rows: (index, from, to) => withinMemory(() => opened().rows(index, from, to)),
  }
}
