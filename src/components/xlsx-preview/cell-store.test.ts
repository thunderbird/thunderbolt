/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WorkbookTooLargeError } from '@/office/xlsx-preview-client'
import type { RowsRead } from '@/office/xlsx-preview-reader'
import { describe, expect, it, mock, spyOn } from 'bun:test'
import type { CSSProperties } from 'react'
import { createCellStore, rowsPerRead } from './cell-store'

type Read = {
  from: number
  to: number
  answer: (rows: RowsRead) => Promise<void>
  fail: (error?: Error) => Promise<void>
}

/** Lets the store run what follows a settled read before the test looks. */
const settled = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

/** A store over 1,000 rows whose reads wait until the test answers them. */
const storeWithReads = () => {
  const reads: Read[] = []
  const onFailed = mock()
  const read = (from: number, to: number) =>
    new Promise<RowsRead>((resolve, reject) => {
      reads.push({
        from,
        to,
        answer: (rows) => {
          resolve(rows)
          return settled()
        },
        fail: (error = new Error('the Worker stopped')) => {
          reject(error)
          return settled()
        },
      })
    })
  const shownRows = Array.from({ length: 1_000 }, (_, row) => row)
  const store = createCellStore(shownRows, read, new Map<number, CSSProperties>(), onFailed)
  return { store, reads, onFailed }
}

const cellIn = (row: number): RowsRead => ({ rows: [{ row, cells: [{ col: 0, text: 'x', style: 0 }] }], styles: [] })

describe('the cell store', () => {
  it('keeps one read in flight, then reads the chunk asked for last that rows still wait on', async () => {
    const { store, reads } = storeWithReads()

    store.subscribe(0, () => {})
    store.subscribe(rowsPerRead, () => {})
    store.subscribe(2 * rowsPerRead, () => {})
    expect(reads.map(({ from }) => from)).toEqual([0])

    await reads[0].answer(cellIn(0))
    // After a fast scroll, the rows now on screen are read before the ones scrolled past.
    expect(reads.map(({ from, to }) => [from, to])).toEqual([
      [0, rowsPerRead],
      [2 * rowsPerRead, 3 * rowsPerRead],
    ])
  })

  it('skips a chunk no row waits on any more, and reads it again once a row mounts there', async () => {
    const { store, reads } = storeWithReads()

    store.subscribe(0, () => {})
    const unsubscribe = store.subscribe(rowsPerRead, () => {})
    unsubscribe()
    await reads[0].answer(cellIn(0))
    expect(reads).toHaveLength(1)

    store.subscribe(rowsPerRead + 3, () => {})
    expect(reads.map(({ from }) => from)).toEqual([0, rowsPerRead])
  })

  it('tells a row still loading from a loaded row with no cells, and calls its listeners once loaded', async () => {
    const { store, reads } = storeWithReads()
    const listener = mock()

    store.subscribe(0, listener)
    expect(store.cells(0)).toBeUndefined()

    await reads[0].answer(cellIn(0))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.cells(0)).toEqual([{ col: 0, text: 'x', style: 0 }])
    expect(store.cells(1)).toEqual([])
    expect(store.cells(rowsPerRead)).toBeUndefined()
  })

  it('calls onFailed when a read fails, and reads nothing after it', async () => {
    const { store, reads, onFailed } = storeWithReads()
    spyOn(console, 'error').mockImplementation(() => {})

    store.subscribe(0, () => {})
    store.subscribe(rowsPerRead, () => {})
    await reads[0].fail()

    expect(onFailed.mock.calls).toEqual([[false]])
    expect(reads).toHaveLength(1)
  })

  it('says when a read failed because the workbook is too large', async () => {
    const { store, reads, onFailed } = storeWithReads()
    spyOn(console, 'error').mockImplementation(() => {})

    store.subscribe(0, () => {})
    await reads[0].fail(new WorkbookTooLargeError('Excelize used more than 536870912 bytes of memory.'))

    expect(onFailed.mock.calls).toEqual([[true]])
  })
})
