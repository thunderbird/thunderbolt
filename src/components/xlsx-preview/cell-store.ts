/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WorkbookTooLargeError } from '@/office/xlsx-preview-client'
import type { PreviewCell, RowsRead } from '@/office/xlsx-preview-reader'
import type { CSSProperties } from 'react'
import { cellCss } from './cell-style'

/** How many shown rows one read asks the Worker for: about 65 ms of Excelize calls for 50 columns, under Bun. */
export const rowsPerRead = 50

/** The cells of one sheet, read from the Worker in chunks of rows as the grid shows them. */
export type CellStore = {
  /** Listen for the row's cells; its chunk is read while anything listens for it. */
  subscribe: (row: number, listener: () => void) => () => void
  /** The row's cells, an empty list for a row with none, or `undefined` while its chunk is still being read. */
  cells: (row: number) => PreviewCell[] | undefined
  /** A style index as CSS. Every style a row uses has arrived with it. */
  css: (style: number) => CSSProperties | undefined
}

const noCells: PreviewCell[] = []

/**
 * A cell store over one sheet's shown rows. `read` asks for the rows numbered from `from` up to, not including, `to`.
 * `styles` is shared by every sheet of the workbook, since style indexes belong to the workbook, and holds each style
 * as CSS once. One read is in flight at a time, and the next is the chunk asked for last that rows still wait on.
 * After a fast scroll the rows on screen come first, and chunks scrolled past are not read at all. A failed read calls
 * `onFailed` with whether the workbook was too large. It must not fail silently, because rows left blank would look
 * like empty cells.
 */
export const createCellStore = (
  shownRows: number[],
  read: (from: number, to: number) => Promise<RowsRead>,
  styles: Map<number, CSSProperties>,
  onFailed: (tooLarge: boolean) => void,
): CellStore => {
  const positions = new Map(shownRows.map((row, position) => [row, position]))
  const rows = new Map<number, PreviewCell[]>()
  const loaded = new Set<number>()
  const listeners = new Map<number, Set<() => void>>()
  // Chunks that rows wait on, oldest request first.
  const wanted: number[] = []
  let reading: number | undefined

  const chunkOf = (row: number) => Math.floor((positions.get(row) ?? 0) / rowsPerRead)

  const load = async (chunk: number) => {
    const first = shownRows[chunk * rowsPerRead]
    const last = shownRows[Math.min(shownRows.length, (chunk + 1) * rowsPerRead) - 1]
    const received = await read(first, last + 1)
    for (const [id, style] of received.styles) {
      styles.set(id, cellCss(style))
    }
    for (const { row, cells } of received.rows) {
      rows.set(row, cells)
    }
    loaded.add(chunk)
    for (const listener of listeners.get(chunk) ?? []) {
      listener()
    }
  }

  const next = async () => {
    if (reading !== undefined) {
      return
    }
    reading = wanted.pop()
    if (reading === undefined) {
      return
    }
    try {
      await load(reading)
    } catch (error) {
      console.error('[xlsx-preview] Could not read rows', error)
      onFailed(error instanceof WorkbookTooLargeError)
      return
    }
    reading = undefined
    void next()
  }

  const unwant = (chunk: number) => {
    const at = wanted.indexOf(chunk)
    if (at !== -1) {
      wanted.splice(at, 1)
    }
  }

  return {
    subscribe: (row, listener) => {
      const chunk = chunkOf(row)
      const waiting = listeners.get(chunk) ?? new Set()
      listeners.set(chunk, waiting.add(listener))
      if (!loaded.has(chunk) && reading !== chunk) {
        unwant(chunk)
        wanted.push(chunk)
        void next()
      }
      return () => {
        waiting.delete(listener)
        if (waiting.size === 0) {
          unwant(chunk)
        }
      }
    },
    cells: (row) => rows.get(row) ?? (loaded.has(chunkOf(row)) ? noCells : undefined),
    css: (style) => styles.get(style),
  }
}
