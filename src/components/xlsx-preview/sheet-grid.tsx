/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useViewSize } from '@/hooks/use-view-size'
import { cn } from '@/lib/utils'
import { columnName } from '@/office/formula-cache'
import { type KeyboardEvent, type MouseEvent, useId, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
import { sheetFontStack } from './cell-style'
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
import { OverlayList, SheetOverlays } from './sheet-overlay'
import { cellId, SheetRow } from './sheet-row'
import type { SheetView } from './use-xlsx-preview-state'

type SheetGridProps = { name: string; sheet: SheetView }

/**
 * Pixels of rows the virtualizer keeps rendered past each edge of the view. This is its default, written out so the
 * grid can tell which merges are taller than it and keep them mounted.
 */
const virtuaBufferSize = 200

/**
 * The grid of one sheet: sticky column and row headers, frozen panes, merged cells, pictures and charts, with
 * virtualized rows. The grid is one tab stop. The arrow keys, Home, End and Page Up/Down move the active cell, which
 * `aria-activedescendant` points at, and scroll it into view.
 */
export const SheetGrid = ({ name, sheet }: SheetGridProps) => {
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

  return (
    <>
      <div
        ref={scrollRef}
        role="grid"
        tabIndex={0}
        aria-label={name}
        aria-readonly="true"
        aria-rowcount={(layout.rows.at(-1) ?? -1) + 2}
        aria-colcount={(layout.cols.at(-1) ?? -1) + 2}
        aria-activedescendant={target && cellId(id, target.row, target.col)}
        dir={layout.rtl ? 'rtl' : 'ltr'}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        className="group/grid relative min-h-0 flex-1 overflow-auto bg-white text-[#000] outline-none"
        style={{
          fontFamily: sheetFontStack,
          fontSize: '14.67px',
          // Scrolling a cell into view keeps it clear of the sticky headers and frozen panes.
          scrollPaddingTop: headerHeight + geometry.frozenHeight,
          scrollPaddingInlineStart: rowHeaderWidth + geometry.frozenWidth,
        }}
      >
        {/* `overflow-clip`, not `overflow-hidden`: an overlay reaching past the grid must not stretch the scroll area,
            and a clip creates no scroll container, so the sticky headers keep working. */}
        <div className="relative overflow-clip" style={{ width: totalWidth }}>
          <div role="row" aria-rowindex={1} className="sticky top-0 z-[5] flex" style={{ height: headerHeight }}>
            <div
              aria-hidden="true"
              className="sticky start-0 z-[6] flex-none border-e border-b border-border bg-muted"
              style={{ width: rowHeaderWidth }}
            />
            {layout.cols.map((col, position) => {
              const frozenCol = position < layout.frozenCols
              return (
                <div
                  key={col}
                  role="columnheader"
                  aria-colindex={col + 2}
                  className={cn(
                    'flex-none border-e border-b border-border bg-muted text-center text-[length:var(--font-size-xs)] leading-5 text-muted-foreground',
                    frozenCol && 'sticky z-[6]',
                  )}
                  style={{
                    width: layout.colWidths[col],
                    insetInlineStart: frozenCol ? rowHeaderWidth + geometry.colLeft[position] : undefined,
                  }}
                >
                  {columnName(col + 1)}
                </div>
              )
            })}
          </div>
          {frozen.length > 0 && (
            <div className="sticky z-[4]" style={{ top: headerHeight, boxShadow: '0 1px 0 #a3a3a3' }}>
              {frozen.map((row) => (
                <SheetRow key={row} grid={grid} row={row} activeCol={target?.row === row ? target.col : undefined} />
              ))}
            </div>
          )}
          <Virtualizer
            ref={virtualizer}
            scrollRef={scrollRef}
            startMargin={headerHeight + geometry.frozenHeight}
            itemSize={defaultRowHeight}
            bufferSize={virtuaBufferSize}
            keepMounted={keepMounted}
            onScroll={onScroll}
            data={body}
          >
            {(row) => (
              <SheetRow key={row} grid={grid} row={row} activeCol={target?.row === row ? target.col : undefined} />
            )}
          </Virtualizer>
          <SheetOverlays overlays={layout.overlays} />
        </div>
      </div>
      <OverlayList overlays={layout.overlays} />
    </>
  )
}
