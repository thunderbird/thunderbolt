/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { xlsxPreviewLimits } from '@/office/constants'
import type { Merge, SheetLayout } from '@/office/xlsx-preview-reader'

export const headerHeight = 20
export const rowHeaderWidth = 40
/** A 15-point row, Excel's default. */
export const defaultRowHeight = 20

/** A cell by its place in the shown rows and columns, not by its row and column numbers. */
export type GridPosition = { row: number; col: number }

/** A merged range's anchor and its size in pixels. */
export type MergeBox = Merge & { width: number; height: number }

/** Where things sit in a sheet's grid, worked out once per layout. */
export type SheetGeometry = {
  /** The left edge of each shown column, by position, from the end of the row headers. */
  colLeft: number[]
  width: number
  frozenWidth: number
  frozenHeight: number
  /** Merged ranges by the `row:col` of their anchor cell. */
  anchors: Map<string, MergeBox>
  /** The merged range each covered cell belongs to, by its `row:col`. */
  coveredBy: Map<string, MergeBox>
  rowPosition: Map<number, number>
}

export const cellKey = (row: number, col: number) => `${row}:${col}`

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/** The geometry of a sheet layout: column edges, frozen sizes, and merged ranges with their pixel sizes. */
export const sheetGeometry = (layout: SheetLayout): SheetGeometry => {
  const widths = layout.cols.map((col) => layout.colWidths[col])
  const colLeft = widths.map((_, position) => sum(widths.slice(0, position)))
  const spanned = (shown: number[], sizes: number[], first: number, count: number) =>
    sum(shown.filter((n) => n >= first && n < first + count).map((n) => sizes[n]))
  const boxes = layout.merges.map((merge) => ({
    ...merge,
    width: spanned(layout.cols, layout.colWidths, merge.col, merge.cols),
    height: spanned(layout.rows, layout.rowHeights, merge.row, merge.rows),
  }))
  const coveredBy = new Map(
    boxes.flatMap((box) =>
      Array.from({ length: box.rows * box.cols }, (_, i) => {
        const row = box.row + Math.floor(i / box.cols)
        const col = box.col + (i % box.cols)
        return [cellKey(row, col), box] as const
      }).filter(([key]) => key !== cellKey(box.row, box.col)),
    ),
  )
  return {
    colLeft,
    width: sum(widths),
    frozenWidth: sum(widths.slice(0, layout.frozenCols)),
    frozenHeight: sum(layout.rows.slice(0, layout.frozenRows).map((row) => layout.rowHeights[row])),
    anchors: new Map(boxes.map((box) => [cellKey(box.row, box.col), box])),
    coveredBy,
    rowPosition: new Map(layout.rows.map((row, position) => [row, position])),
  }
}

/**
 * The layout with each frozen pane kept only while it fits the view beside the headers and holds no more rows or
 * columns than the caps. A pane frozen at row 5,000 would mount every row at once, outside the virtualized list,
 * and leave nothing to scroll. The caps are needed as well as the size check, because rows a tenth of a pixel tall
 * would fit the view.
 */
export const fitFrozenPanes = (layout: SheetLayout, view: { width: number; height: number }): SheetLayout => {
  const frozenHeight = sum(layout.rows.slice(0, layout.frozenRows).map((row) => layout.rowHeights[row]))
  const frozenWidth = sum(layout.cols.slice(0, layout.frozenCols).map((col) => layout.colWidths[col]))
  const rowsFit = headerHeight + frozenHeight < view.height && layout.frozenRows <= xlsxPreviewLimits.frozenRows
  const colsFit = rowHeaderWidth + frozenWidth < view.width && layout.frozenCols <= xlsxPreviewLimits.frozenColumns
  const frozenRows = rowsFit ? layout.frozenRows : 0
  const frozenCols = colsFit ? layout.frozenCols : 0
  return frozenRows === layout.frozenRows && frozenCols === layout.frozenCols
    ? layout
    : { ...layout, frozenRows, frozenCols }
}

type Bounds = { lastRow: number; lastCol: number; pageRows: number; rtl: boolean }

const clampPosition = ({ row, col }: GridPosition, { lastRow, lastCol }: Bounds) => ({
  row: Math.min(lastRow, Math.max(0, row)),
  col: Math.min(lastCol, Math.max(0, col)),
})

/**
 * Where a key moves the active cell, as in a spreadsheet: arrows by one cell, Home and End along the row, with
 * Ctrl (or Cmd) to the first and last cell, Page Up and Page Down by a screen of rows. Other keys return `undefined`.
 * In a right-to-left sheet the left arrow moves to the next column.
 */
export const nextPosition = (
  key: string,
  withModifier: boolean,
  { row, col }: GridPosition,
  bounds: Bounds,
): GridPosition | undefined => {
  const forward = bounds.rtl ? -1 : 1
  const moves = new Map<string, GridPosition>([
    ['ArrowDown', { row: row + 1, col }],
    ['ArrowUp', { row: row - 1, col }],
    ['ArrowRight', { row, col: col + forward }],
    ['ArrowLeft', { row, col: col - forward }],
    ['PageDown', { row: row + bounds.pageRows, col }],
    ['PageUp', { row: row - bounds.pageRows, col }],
    ['Home', withModifier ? { row: 0, col: 0 } : { row, col: 0 }],
    ['End', withModifier ? { row: bounds.lastRow, col: bounds.lastCol } : { row, col: bounds.lastCol }],
  ])
  const next = moves.get(key)
  return next && clampPosition(next, bounds)
}
