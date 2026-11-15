/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type PreviewClient, PreviewLoadError, WorkbookTooLargeError } from '@/office/xlsx-preview-client'
import type { SheetLayout, WorkbookOverview } from '@/office/xlsx-preview-reader'
import { type CSSProperties, type Dispatch, useEffect, useReducer, useRef } from 'react'
import { type CellStore, createCellStore } from './cell-store'

export type SheetView = { index: number; layout: SheetLayout; cells: CellStore }

/** Why the preview failed: the file may be damaged, too large to read, or Excelize could not load at all. */
export type PreviewFailure = 'damaged' | 'tooLarge' | 'notLoaded'

type XlsxPreviewState =
  | { status: 'loading' }
  | { status: 'error'; failure: PreviewFailure }
  | { status: 'ready'; overview: WorkbookOverview; sheetIndex: number; sheet?: SheetView }

type Action =
  | { type: 'opened'; overview: WorkbookOverview; sheetIndex: number }
  | { type: 'selected'; index: number }
  | { type: 'sheetLoaded'; sheet: SheetView }
  | { type: 'failed'; failure: PreviewFailure }

const reducer = (state: XlsxPreviewState, action: Action): XlsxPreviewState => {
  switch (action.type) {
    case 'opened':
      return { status: 'ready', overview: action.overview, sheetIndex: action.sheetIndex }
    case 'selected':
      return state.status === 'ready' ? { ...state, sheetIndex: action.index, sheet: undefined } : state
    case 'sheetLoaded':
      // A sheet that arrives after the user picked another one is dropped.
      return state.status === 'ready' && state.sheetIndex === action.sheet.index
        ? { ...state, sheet: action.sheet }
        : state
    case 'failed':
      return { status: 'error', failure: action.failure }
  }
}

/**
 * The sheet the user last picked in each file, by file id, for this run of the app: the panel turns into a dialog at
 * the mobile breakpoint and back, which mounts the preview again, and the file should reopen where the user left it.
 */
const selectedSheets = new Map<string, number>()

/** One Worker, the workbook's styles as CSS and the sheet on show, for as long as the preview shows one file. */
type Session = { client: PreviewClient; styles: Map<number, CSSProperties>; selected: number; closed: boolean }

/** Terminate the Worker, once. WebAssembly memory never shrinks, so only ending the Worker frees Excelize's memory. */
const end = (session: Session) => {
  if (!session.closed) {
    session.closed = true
    session.client.close()
  }
}

/**
 * Show the error state, which says why the preview failed, and end the Worker. A failure in a sheet the user has
 * already left is ignored.
 */
const fail = (session: Session, dispatch: Dispatch<Action>, failure: PreviewFailure, sheet?: number) => {
  if (session.closed || (sheet !== undefined && sheet !== session.selected)) {
    return
  }
  dispatch({ type: 'failed', failure })
  end(session)
}

const loadSheet = async (session: Session, index: number, dispatch: Dispatch<Action>) => {
  const layout = await session.client.sheet(index)
  if (session.closed) {
    return
  }
  const read = (from: number, to: number) => session.client.rows(index, from, to)
  const cells = createCellStore(layout.rows, read, session.styles, (tooLarge) =>
    fail(session, dispatch, tooLarge ? 'tooLarge' : 'damaged', index),
  )
  dispatch({ type: 'sheetLoaded', sheet: { index, layout, cells } })
}

/** Run a read; a failure shows the error state. `sheet` names the sheet it reads, if it reads one. */
const guard = async (session: Session, dispatch: Dispatch<Action>, read: () => Promise<void>, sheet?: number) => {
  try {
    await read()
  } catch (error) {
    console.error('[xlsx-preview] Could not read the workbook', error)
    const failure = error instanceof PreviewLoadError ? 'notLoaded' : 'damaged'
    fail(session, dispatch, error instanceof WorkbookTooLargeError ? 'tooLarge' : failure, sheet)
  }
}

/**
 * The spreadsheet preview's state. A Worker starts when the preview opens a file. It is terminated when the preview
 * unmounts or the file changes, and as soon as nothing is left to read: an error, no visible sheet, or none small
 * enough to read. A sheet too large to read is never asked for. The file opens on the sheet the user last picked in
 * it, by `fileId`.
 */
export const useXlsxPreviewState = (blob: Blob, createClient: () => PreviewClient, fileId: string) => {
  const [state, dispatch] = useReducer(reducer, { status: 'loading' })
  const sessionRef = useRef<Session | null>(null)

  useEffect(() => {
    const session: Session = { client: createClient(), styles: new Map(), selected: 0, closed: false }
    sessionRef.current = session
    const open = async () => {
      const overview = await session.client.open(new Uint8Array(await blob.arrayBuffer()))
      if (session.closed) {
        return
      }
      const remembered = selectedSheets.get(fileId) ?? 0
      const first = remembered < overview.sheets.length ? remembered : 0
      session.selected = first
      dispatch({ type: 'opened', overview, sheetIndex: first })
      if (overview.sheets.every(({ tooLarge }) => tooLarge)) {
        end(session)
        return
      }
      if (!overview.sheets[first].tooLarge) {
        void guard(session, dispatch, () => loadSheet(session, first, dispatch), first)
      }
    }
    void guard(session, dispatch, open)
    return () => end(session)
  }, [blob, createClient, fileId])

  const selectSheet = (index: number) => {
    const session = sessionRef.current
    if (!session || state.status !== 'ready' || state.sheetIndex === index) {
      return
    }
    selectedSheets.set(fileId, index)
    session.selected = index
    dispatch({ type: 'selected', index })
    if (!state.overview.sheets[index].tooLarge) {
      void guard(session, dispatch, () => loadSheet(session, index, dispatch), index)
    }
  }

  return { state, selectSheet }
}
