/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SheetLayout } from '@/office/xlsx-preview-reader'
import { describe, expect, it } from 'bun:test'
import { fitFrozenPanes, nextPosition, sheetGeometry } from './sheet-geometry'

const bounds = { lastRow: 9, lastCol: 4, pageRows: 5, rtl: false }

describe('nextPosition', () => {
  it('moves by one cell with the arrows and stops at the edges', () => {
    expect(nextPosition('ArrowDown', false, { row: 0, col: 0 }, bounds)).toEqual({ row: 1, col: 0 })
    expect(nextPosition('ArrowRight', false, { row: 0, col: 4 }, bounds)).toEqual({ row: 0, col: 4 })
    expect(nextPosition('ArrowUp', false, { row: 0, col: 2 }, bounds)).toEqual({ row: 0, col: 2 })
  })

  it('swaps the left and right arrows in a right-to-left sheet', () => {
    expect(nextPosition('ArrowLeft', false, { row: 0, col: 1 }, { ...bounds, rtl: true })).toEqual({ row: 0, col: 2 })
  })

  it('goes along the row with Home and End, and to the corners with Ctrl', () => {
    expect(nextPosition('End', false, { row: 3, col: 1 }, bounds)).toEqual({ row: 3, col: 4 })
    expect(nextPosition('Home', false, { row: 3, col: 1 }, bounds)).toEqual({ row: 3, col: 0 })
    expect(nextPosition('End', true, { row: 3, col: 1 }, bounds)).toEqual({ row: 9, col: 4 })
    expect(nextPosition('Home', true, { row: 3, col: 1 }, bounds)).toEqual({ row: 0, col: 0 })
  })

  it('pages by a screen of rows and ignores other keys', () => {
    expect(nextPosition('PageDown', false, { row: 7, col: 1 }, bounds)).toEqual({ row: 9, col: 1 })
    expect(nextPosition('PageUp', false, { row: 7, col: 1 }, bounds)).toEqual({ row: 2, col: 1 })
    expect(nextPosition('a', false, { row: 7, col: 1 }, bounds)).toBeUndefined()
  })
})

describe('sheetGeometry', () => {
  const layout: SheetLayout = {
    rows: [0, 1, 2, 4],
    cols: [0, 2, 3],
    rowHeights: [20, 30, 20, 20, 25],
    colWidths: [64, 100, 70, 80],
    frozenRows: 1,
    frozenCols: 1,
    merges: [{ row: 1, col: 0, rows: 4, cols: 3 }],
    overlays: [],
    leftOutObjects: 0,
    rtl: false,
  }

  it('sizes merged ranges without their hidden rows and columns', () => {
    const geometry = sheetGeometry(layout)

    expect(geometry.anchors.get('1:0')).toMatchObject({ width: 64 + 70, height: 30 + 20 + 25 })
    expect(geometry.coveredBy.get('2:2')).toBe(geometry.anchors.get('1:0'))
    expect(geometry.coveredBy.has('1:0')).toBe(false)
  })

  it('places the shown columns and measures the frozen panes', () => {
    const geometry = sheetGeometry(layout)

    expect(geometry.colLeft).toEqual([0, 64, 134])
    expect(geometry.width).toBe(64 + 70 + 80)
    expect(geometry.frozenWidth).toBe(64)
    expect(geometry.frozenHeight).toBe(20)
  })

  it('freezes a pane only while it fits the view beside the headers', () => {
    // Frozen: row 0 (20px) under the 20px header, column 0 (64px) beside the 40px row headers.
    expect(fitFrozenPanes(layout, { width: 105, height: 41 })).toBe(layout)
    expect(fitFrozenPanes(layout, { width: 104, height: 41 })).toMatchObject({ frozenRows: 1, frozenCols: 0 })
    expect(fitFrozenPanes(layout, { width: 105, height: 40 })).toMatchObject({ frozenRows: 0, frozenCols: 1 })
  })

  it('freezes no more rows and columns than the caps, however small the rows and columns are', () => {
    const tiny = (count: number) => Array.from({ length: count }, (_, i) => i)
    const frozen = (rows: number, cols: number): SheetLayout => ({
      ...layout,
      rows: tiny(100),
      cols: tiny(20),
      rowHeights: tiny(100).map(() => 0.1),
      colWidths: tiny(20).map(() => 1),
      merges: [],
      frozenRows: rows,
      frozenCols: cols,
    })
    const view = { width: 1_000, height: 1_000 }

    expect(fitFrozenPanes(frozen(50, 10), view)).toMatchObject({ frozenRows: 50, frozenCols: 10 })
    expect(fitFrozenPanes(frozen(51, 11), view)).toMatchObject({ frozenRows: 0, frozenCols: 0 })
  })
})
