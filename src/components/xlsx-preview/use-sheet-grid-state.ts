/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useViewSize } from '@/hooks/use-view-size'
import { type KeyboardEvent, type MouseEvent, useId, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { VirtualizerHandle } from 'virtua'
import {
  cellKey,
  defaultRowHeight,
  fitFrozenPanes,
  type GridPosition,
  headerHeight,
  nextPosition,
  rowHeaderWidth,
  sheetGeometry,
} from './sheet-geometry'
import { cellId } from './sheet-row'
import type { SheetView } from './use-xlsx-preview-state'

/**
 * Pixels of rows the virtualizer keeps rendered past each edge of the view. This is its default, written out so the
 * grid can tell which merges are taller than it and keep them mounted.
 */
export const virtuaBufferSize = 200

/**
 * State and handlers of one sheet's grid: its fitted layout and geometry, the active cell and the keys that move it,
 * and the rows the virtualizer must keep mounted.
 */
export const useSheetGridState = (sheet: SheetView) => {
  const { cells } = sheet
  const id = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useRef<VirtualizerHandle>(null)
  // The grid's own size, to tell whether its frozen panes fit.
  const view = useViewSize(scrollRef)
  const layout = useMemo(() => fitFrozenPanes(sheet.layout, view), [sheet.layout, view])
  const geometry = useMemo(() => sheetGeometry(layout), [layout])
  const grid = useMemo(() => ({ id, layout, geometry, cells }), [id, layout, geometry, cells])
  const [active, setActive] = useState<GridPosition>({ row: 0, col: 0 })
  const [keptMerges, setKeptMerges] = useState<number[]>([])

  // A cell inside a merged range is drawn by the range's first cell, so that one is the active descendant. The
  // reader drops merges whose first cell is hidden, so the target is always a cell the grid renders.
  const targetOf = ({ row, col }: GridPosition) => {
    const sheetRow = layout.rows[row]
    const sheetCol = layout.cols[col]
    const merge = geometry.coveredBy.get(cellKey(sheetRow, sheetCol))
    return merge ? { row: merge.row, col: merge.col } : { row: sheetRow, col: sheetCol }
  }
  // Every column the grid reaches can be hidden, and then no cell can be active.
  const hasCells = layout.rows.length > 0 && layout.cols.length > 0
  const target = hasCells ? targetOf(active) : undefined
  const frozen = layout.rows.slice(0, layout.frozenRows)
  const body = layout.rows.slice(layout.frozenRows)
  const bodyIndexOf = (row: number) => (geometry.rowPosition.get(row) ?? -1) - layout.frozenRows
  // Merged ranges taller than the virtualizer's buffer, by the list index of their first row.
  const tallMerges = useMemo(
    () =>
      [...geometry.anchors.values()]
        .filter(({ height }) => height > virtuaBufferSize)
        .map(({ row, height }) => ({ index: (geometry.rowPosition.get(row) ?? -1) - layout.frozenRows, height }))
        .filter(({ index }) => index >= 0),
    [geometry, layout.frozenRows],
  )
  const keepMounted = [...new Set([target ? bodyIndexOf(target.row) : -1, ...keptMerges])]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
  const totalWidth = rowHeaderWidth + geometry.width

  // A tall merge whose first row scrolled out of the virtualizer's range would vanish though it still covers the
  // view, so that row stays mounted while the merge reaches into the view. Merges do not overlap, so the top edge of
  // the view crosses at most one per column.
  const onScroll = (offset: number) => {
    const handle = virtualizer.current
    if (!handle || tallMerges.length === 0) {
      return
    }
    const reaching = tallMerges
      .filter(({ index, height }) => {
        const top = handle.getItemOffset(index)
        return top < offset && top + height > offset
      })
      .map(({ index }) => index)
    setKeptMerges((current) => (current.join() === reaching.join() ? current : reaching))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!hasCells) {
      return
    }
    const next = nextPosition(event.key, event.ctrlKey || event.metaKey, active, {
      lastRow: layout.rows.length - 1,
      lastCol: layout.cols.length - 1,
      pageRows: Math.max(1, Math.floor((event.currentTarget.clientHeight - headerHeight) / defaultRowHeight) - 1),
      rtl: layout.rtl,
    })
    if (!next) {
      return
    }
    event.preventDefault()
    // The new active row must be mounted before it can be scrolled to, and `keepMounted` keeps it mounted.
    flushSync(() => setActive(next))
    const { row, col } = targetOf(next)
    document.getElementById(cellId(id, row, col))?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const cell = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-row]') : null
    if (cell) {
      setActive({ row: Number(cell.dataset.row), col: Number(cell.dataset.col) })
    }
  }

  return {
    id,
    scrollRef,
    virtualizer,
    layout,
    geometry,
    grid,
    target,
    frozen,
    body,
    keepMounted,
    totalWidth,
    onScroll,
    onKeyDown,
    onMouseDown,
  }
}
