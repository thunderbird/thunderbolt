/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PreviewCell, SheetLayout } from '@/office/xlsx-preview-reader'
import { memo, useCallback, useSyncExternalStore } from 'react'
import type { CellStore } from './cell-store'
import { SheetCell, textAlignOf } from './sheet-cell'
import { cellKey, rowHeaderWidth, type SheetGeometry } from './sheet-geometry'

/** What every row of one sheet shares; built once per sheet, so rows can skip re-rendering. */
type SheetGridContext = { id: string; layout: SheetLayout; geometry: SheetGeometry; cells: CellStore }

/** The id of a cell, for `aria-activedescendant`. */
export const cellId = (gridId: string, row: number, col: number) => `${gridId}-${row}-${col}`

// Excel stops unwrapped text running into the next cells long before this.
const maxRunColumns = 12

/** How wide unwrapped text may run: its own column and the empty, unmerged columns after it, as in Excel. */
const runWidth = (grid: SheetGridContext, row: number, position: number, byCol: Map<number, PreviewCell>) => {
  const { layout, geometry } = grid
  const after = layout.cols.slice(position + 1, position + 1 + maxRunColumns)
  const blocked = after.findIndex(
    (col) => byCol.has(col) || geometry.anchors.has(cellKey(row, col)) || geometry.coveredBy.has(cellKey(row, col)),
  )
  const free = blocked === -1 ? after : after.slice(0, blocked)
  return [layout.cols[position], ...free].reduce((width, col) => width + layout.colWidths[col], 0)
}

type SheetRowProps = {
  grid: SheetGridContext
  row: number
  /** The active cell's column, when it is in this row. */
  activeCol?: number
}

/** One sheet row: its header, then each shown column. Its cells are read from the Worker when the row first shows. */
export const SheetRow = memo(({ grid, row, activeCol }: SheetRowProps) => {
  const { id, layout, geometry, cells } = grid
  const subscribe = useCallback((listener: () => void) => cells.subscribe(row, listener), [cells, row])
  const rowCells = useSyncExternalStore(subscribe, () => cells.cells(row))
  const byCol = new Map((rowCells ?? []).map((cell) => [cell.col, cell]))
  const rowPosition = geometry.rowPosition.get(row) ?? 0
  const loading = rowCells === undefined

  return (
    <div
      role="row"
      aria-rowindex={row + 2}
      aria-busy={loading || undefined}
      className="relative flex"
      style={{ height: layout.rowHeights[row] }}
    >
      {/* One grey cover over the row while its cells are read, so it does not pass for a row of empty cells. It is
          one element because restyling each cell costs too much: swapping 2,500 cells' classes as each chunk
          landed took WebKit's p95 scroll frame from about 60 ms to 110 ms. */}
      {loading && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 end-0 z-[2] bg-[#f3f3f3]"
          style={{ insetInlineStart: rowHeaderWidth }}
        />
      )}
      <div
        role="rowheader"
        aria-colindex={1}
        className="sticky start-0 z-[3] flex flex-none items-center justify-center border-e border-b border-border bg-muted text-[length:var(--font-size-xs)] tabular-nums text-muted-foreground"
        style={{ width: rowHeaderWidth }}
      >
        {row + 1}
      </div>
      {layout.cols.map((col, position) => {
        const key = cellKey(row, col)
        const width = layout.colWidths[col]
        if (geometry.coveredBy.has(key)) {
          return <div key={col} aria-hidden="true" className="flex-none" style={{ width }} />
        }
        const cell = byCol.get(col)
        const css = cell ? cells.css(cell.style) : undefined
        const merge = geometry.anchors.get(key)
        const runs = cell?.text && !css?.whiteSpace && textAlignOf(css, cell) === 'left'
        const run = runs ? runWidth(grid, row, position, byCol) : width
        const box = merge ?? (run > width ? { width: run, height: layout.rowHeights[row] } : undefined)
        return (
          <SheetCell
            key={col}
            id={cellId(id, row, col)}
            col={col}
            position={{ row: rowPosition, col: position }}
            width={width}
            box={box}
            merge={merge}
            frozenAt={position < layout.frozenCols ? rowHeaderWidth + geometry.colLeft[position] : undefined}
            cell={cell}
            css={css}
            active={activeCol === col}
          />
        )
      })}
    </div>
  )
})
SheetRow.displayName = 'SheetRow'
