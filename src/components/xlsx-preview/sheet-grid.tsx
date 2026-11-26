/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { columnName } from '@/office/formula-cache'
import { type CustomItemComponentProps, Virtualizer } from 'virtua'
import { sheetFontStack } from './cell-style'
import { defaultRowHeight, headerHeight, rowHeaderWidth } from './sheet-geometry'
import { OverlayList, SheetOverlays } from './sheet-overlay'
import { cellId, SheetRow } from './sheet-row'
import { useSheetGridState, virtuaBufferSize } from './use-sheet-grid-state'
import type { SheetView } from './use-xlsx-preview-state'

type SheetGridProps = { name: string; sheet: SheetView }

/**
 * A virtualized row's wrapper without the layout containment the virtualizer gives it. Containment makes each row a
 * stacking context, which would put the charts and pictures over its sticky row header and frozen columns.
 */
const RowItem = ({ style, children, ref }: CustomItemComponentProps) => (
  <div ref={ref} style={{ ...style, contain: undefined }}>
    {children}
  </div>
)

/**
 * The grid of one sheet: sticky column and row headers, frozen panes, merged cells, pictures and charts, with
 * virtualized rows. The grid is one tab stop. The arrow keys, Home, End and Page Up/Down move the active cell, which
 * `aria-activedescendant` points at, and scroll it into view.
 */
export const SheetGrid = ({ name, sheet }: SheetGridProps) => {
  const {
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
  } = useSheetGridState(sheet)

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
            item={RowItem}
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
