/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContentViewProvider } from '@/content-view/context'
import { xlsxMime } from '@/files/transformers'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { xlsxPreviewLimits } from '@/office/constants'
import { type PreviewClient, PreviewLoadError, WorkbookTooLargeError } from '@/office/xlsx-preview-client'
import { columnName } from '@/office/formula-cache'
import { type RowsRead, settle } from '@/office/xlsx-preview-reader'
import {
  hostileProbeUrl,
  hostileWorkbook,
  inProcessPreviewClient,
  loadTestEngine,
  saveWorkbook,
  styledWorkbook,
  tinyPng,
} from '@/office/xlsx-preview-test-runtime'
import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { LocalXlsxSidebarViewer } from './local-xlsx-sidebar-viewer'

// Loaded before any test installs fake timers, because Go's runtime needs real ones to start.
const engine = await loadTestEngine()
const { excelize } = engine

const storedFiles = new Map<string, attachmentStorage.StoredFile>()

// Ticks, not `runAllAsync`: Go's runtime keeps a timer pending, so running every timer would never end.
const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => void (await getClock().tickAsync(20)))
  }
}

const showWorkbook = async (bytes: Uint8Array<ArrayBuffer>, createClient = inProcessPreviewClient(engine)) => {
  const id = crypto.randomUUID()
  storedFiles.set(id, {
    id,
    filename: 'budget.xlsx',
    mimeType: xlsxMime,
    size: bytes.byteLength,
    createdAt: 0,
    blob: new Blob([bytes], { type: xlsxMime }),
  })
  const view = render(
    <ContentViewProvider>
      <LocalXlsxSidebarViewer localFileId={id} fileName="budget.xlsx" createClient={createClient} />
    </ContentViewProvider>,
  )
  await flush()
  return view
}

/** A plain grid of numbers, `rows` by `cols`, on Sheet1. */
const numberGrid = (rows: number, cols: number) => {
  const f = excelize.NewFile()
  for (let row = 1; row <= rows; row++) {
    settle(
      f.SetSheetRow(
        'Sheet1',
        `A${row}`,
        Array.from({ length: cols }, (_, col) => row * 10 + col),
      ),
    )
  }
  return saveWorkbook(f)
}

/** The in-process client, with its overview saying the sheets at these indexes are too large to read. */
const reportingTooLarge = (tooLarge: number[], onClose?: () => void) => (): PreviewClient => {
  const client = inProcessPreviewClient(engine, onClose)()
  return {
    ...client,
    open: async (bytes) => {
      const overview = await client.open(bytes)
      return { ...overview, sheets: overview.sheets.map((sheet, i) => ({ ...sheet, tooLarge: tooLarge.includes(i) })) }
    },
    sheet: mock(client.sheet),
  }
}

describe('the spreadsheet preview', () => {
  let getAttachment: Mock<typeof attachmentStorage.getAttachment>
  let objectUrls: Mock<typeof URL.createObjectURL>
  let restoreVirtua: () => void

  beforeEach(() => {
    getAttachment = spyOn(attachmentStorage, 'getAttachment').mockImplementation(
      async (id) => storedFiles.get(id) ?? null,
    )
    objectUrls = spyOn(URL, 'createObjectURL')
    restoreVirtua = mockVirtuaMeasurement({
      viewportHeight: 600,
      itemHeight: 20,
      isViewport: (target) => target.getAttribute('role') === 'grid',
    })
  })

  afterEach(() => {
    cleanup()
    getAttachment.mockRestore()
    objectUrls.mockRestore()
    restoreVirtua()
  })

  /** Clicks Download and returns what it hands the browser: the file name and the file's bytes. */
  const clickDownload = async () => {
    const appended = spyOn(document.body, 'appendChild')
    const click = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
      const anchor = appended.mock.calls.map(([node]) => node).find((node) => node instanceof HTMLAnchorElement)
      const blob = objectUrls.mock.calls[objectUrls.mock.results.findIndex(({ value }) => value === anchor?.href)]?.[0]
      expect(click).toHaveBeenCalledTimes(1)
      return { name: anchor?.download, bytes: blob instanceof Blob ? new Uint8Array(await blob.arrayBuffer()) : null }
    } finally {
      appended.mockRestore()
      click.mockRestore()
    }
  }

  it('shows a styled workbook as a grid with its visible sheets as tabs', async () => {
    const { container } = await showWorkbook(styledWorkbook(excelize))

    const grid = screen.getByRole('grid', { name: 'Budget' })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Budget', 'Notes'])
    expect(within(grid).getByText('$1,200.00')).toBeDefined()
    expect(within(grid).getByText('1-Jan-2026')).toBeDefined()
    expect(within(grid).getByText('12.5%')).toBeDefined()
    expect(within(grid).getByText('$1,200.00').closest('[role="gridcell"]')?.getAttribute('aria-colindex')).toBe('4')
    // Shown rows run to the 34th and shown columns to N; the header row and column count as one each.
    expect(grid.getAttribute('aria-rowcount')).toBe('35')
    expect(grid.getAttribute('aria-colcount')).toBe('15')
    expect(within(grid).getAllByRole('columnheader')[0].textContent).toBe('A')
    expect(within(grid).getAllByRole('rowheader')[0].textContent).toBe('1')
    expect(within(grid).queryByText('Hidden row')).toBeNull()
    expect(within(grid).queryByText('Hidden column')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(within(grid).getByText('Docs').closest('[style*="underline"]')).not.toBeNull()
  })

  it('merges cells and keeps the title in the merged range', async () => {
    await showWorkbook(styledWorkbook(excelize))

    expect(screen.getAllByText('Q1 budget')).toHaveLength(1)
    const title = screen.getByText('Q1 budget').closest('[role="gridcell"]')
    expect(title?.getAttribute('aria-colspan')).toBe('4')
    expect(title?.querySelector('div')?.getAttribute('style')?.toLowerCase()).toContain('background: #1f3864')
  })

  it('draws charts and pictures over the grid, hidden from screen readers, and names each in a list beside it', async () => {
    await showWorkbook(styledWorkbook(excelize))

    const grid = screen.getByRole('grid', { name: 'Budget' })
    const chart = [...grid.querySelectorAll('svg')].find((svg) => svg.querySelectorAll('rect').length >= 2)
    expect(chart?.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(grid.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
    expect(within(grid).queryByRole('img')).toBeNull()
    const list = screen.getByRole('list', { name: 'Charts and pictures' })
    expect(grid.contains(list)).toBe(false)
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Logo', 'Column chart: Spend', 'Radar chart: Mix Not shown in this preview'])
  })

  it('lists what the preview leaves out in one note', async () => {
    await showWorkbook(styledWorkbook(excelize))

    const note = screen.getByRole('note')
    const items = within(note)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(items).toEqual([
      '1 hidden sheet',
      'Conditional formatting',
      '1 formula with no saved result',
      '1 chart of a type the preview does not draw',
    ])
  })

  it('switches sheets from the tabs', async () => {
    await showWorkbook(styledWorkbook(excelize))

    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }))
    await flush()

    expect(within(screen.getByRole('grid', { name: 'Notes' })).getByText('Second sheet')).toBeDefined()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      screen.getByRole('tab', { name: 'Notes' }).id,
    )
  })

  it('moves between sheet tabs with the arrow keys, one tab stop for them all', async () => {
    await showWorkbook(styledWorkbook(excelize))
    const [budget, notes] = screen.getAllByRole('tab')

    expect([budget.tabIndex, notes.tabIndex]).toEqual([0, -1])
    expect(budget.getAttribute('aria-selected')).toBe('true')
    budget.focus()
    fireEvent.keyDown(screen.getByRole('tablist', { name: 'Sheets' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(notes)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(budget)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' })
    expect(document.activeElement).toBe(notes)
  })

  it('stops at the row and column caps and says how many it shows', async () => {
    const f = excelize.NewFile()
    settle(
      f.SetSheetRow(
        'Sheet1',
        'A1',
        Array.from({ length: 51 }, (_, col) => col),
      ),
    )
    settle(
      f.SetSheetCol(
        'Sheet1',
        'A2',
        Array.from({ length: 5_000 }, (_, row) => row),
      ),
    )
    await showWorkbook(saveWorkbook(f))

    const grid = screen.getByRole('grid', { name: 'Sheet1' })
    expect(grid.getAttribute('aria-rowcount')).toBe(String(xlsxPreviewLimits.rows + 1))
    expect(grid.getAttribute('aria-colcount')).toBe(String(xlsxPreviewLimits.columns + 1))
    expect(
      within(screen.getByRole('note')).getByText('Rows after the first 5,000 in Sheet1, which has 5,001'),
    ).toBeDefined()
    expect(
      within(screen.getByRole('note')).getByText('Columns after the first 50 in Sheet1, which has 51'),
    ).toBeDefined()
  })

  it('refuses a file over the size limit without starting a Worker, and Download still works', async () => {
    const createClient = mock((): PreviewClient => {
      throw new Error('No Worker may start for this file.')
    })
    const bytes = new Uint8Array(xlsxPreviewLimits.fileBytes + 1)
    bytes[0] = 7
    await showWorkbook(bytes, createClient)

    expect(screen.getByText('This workbook is too large to preview')).toBeDefined()
    expect(screen.queryByRole('grid')).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
    expect(await clickDownload()).toEqual({ name: 'budget.xlsx', bytes })
  })

  it('makes one picture URL for a picture the file places many times', async () => {
    const f = excelize.NewFile()
    for (const cell of ['A1', 'D1', 'G1']) {
      settle(
        f.AddPictureFromBytes('Sheet1', cell, {
          Extension: '.png',
          File: tinyPng,
          Format: { AltText: 'Logo' },
          InsertType: excelize.PictureInsertTypePlaceOverCells,
        }),
      )
    }
    await showWorkbook(saveWorkbook(f))

    const sources = [...screen.getByRole('grid').querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(sources).toHaveLength(3)
    expect(new Set(sources).size).toBe(1)
    const pictureUrls = objectUrls.mock.calls.filter(([blob]) => blob instanceof Blob && blob.type === 'image/png')
    expect(pictureUrls).toHaveLength(1)
  })

  it('shows hostile text as text, draws no link and loads no picture from outside the file', async () => {
    const { container } = await showWorkbook(hostileWorkbook(excelize))

    const grid = screen.getByRole('grid', { name: '<img src=x onerror=alert(1)>' })
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- the assertion queries literal text; it inserts no HTML.
    expect(within(grid).getByText('<script>window.__xlsxProbe=1</script>')).toBeDefined()
    expect(within(grid).getByText('<img src=x onerror="window.__xlsxProbe=1">')).toBeDefined()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a, [href]')).toBeNull()
    expect(within(grid).getByText('click me').closest('[onclick]')).toBeNull()
    // Only the embedded PNG becomes a picture: the SVG is not a raster type and the linked one is never read.
    const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '')
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatch(/^blob:/)
    expect(container.innerHTML).not.toContain(hostileProbeUrl)
    expect('__xlsxProbe' in window).toBe(false)
  })

  it('draws a 32,767-character cell cut to the cell limit, so WebKit still paints the grid', async () => {
    await showWorkbook(hostileWorkbook(excelize))

    const long = screen.getByText((text) => text.startsWith('LLL'))
    expect(long.textContent).toHaveLength(xlsxPreviewLimits.cellChars + 1)
    expect(within(screen.getByRole('note')).getByText('Text past the first 1,000 characters of a cell')).toBeDefined()
  })

  it('moves the active cell with the keyboard and scrolls it into view', async () => {
    const scrollIntoView = spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      await showWorkbook(numberGrid(3, 3))
      const grid = screen.getByRole('grid', { name: 'Sheet1' })
      const activeCell = () => document.getElementById(grid.getAttribute('aria-activedescendant') ?? '')
      const press = (key: string, ctrlKey = false) => act(() => void fireEvent.keyDown(grid, { key, ctrlKey }))

      expect(grid.tabIndex).toBe(0)
      expect(activeCell()?.textContent).toBe('10')
      await press('ArrowRight')
      expect(activeCell()?.textContent).toBe('11')
      await press('ArrowDown')
      expect(activeCell()?.textContent).toBe('21')
      await press('Home')
      expect(activeCell()?.textContent).toBe('20')
      await press('End')
      expect(activeCell()?.getAttribute('aria-colindex')).toBe('11')
      await press('Home', true)
      expect(activeCell()?.textContent).toBe('10')
      await press('PageDown')
      expect(activeCell()?.closest('[role="row"]')?.getAttribute('aria-rowindex')).not.toBe('2')
      await press('End', true)
      expect(activeCell()?.closest('[role="row"]')?.getAttribute('aria-rowindex')).toBe('31')
      expect(activeCell()?.getAttribute('role')).toBe('gridcell')
      expect(scrollIntoView).toHaveBeenCalled()
    } finally {
      scrollIntoView.mockRestore()
    }
  })

  it('keeps a merged range taller than the render buffer mounted while it reaches into the view', async () => {
    const f = excelize.NewFile()
    settle(f.SetCellValue('Sheet1', 'A60', 'Tall merge'))
    settle(f.MergeCell('Sheet1', 'A60', 'A90'))
    settle(f.SetCellValue('Sheet1', 'A200', 'end'))
    await showWorkbook(saveWorkbook(f))
    const grid = screen.getByRole('grid', { name: 'Sheet1' })
    const scrollTo = async (offset: number) => {
      grid.scrollTop = offset
      fireEvent.scroll(grid)
      await flush()
    }

    expect(screen.queryByText('Tall merge')).toBeNull()
    // Rows from 75 on are in view and the virtualizer's buffer starts ten rows above them, so row 60 is mounted only
    // because the grid keeps it.
    await scrollTo(1_500)
    expect(screen.getByText('Tall merge').closest('[role="gridcell"]')?.getAttribute('aria-rowspan')).toBe('31')
    expect(screen.queryByRole('rowheader', { name: '55' })).toBeNull()
    // Past the range's end, it is released.
    await scrollTo(3_000)
    expect(screen.queryByText('Tall merge')).toBeNull()
  })

  it('keeps every tall merge that reaches into the view mounted, however many there are', async () => {
    const f = excelize.NewFile()
    const columns = Array.from({ length: 25 }, (_, i) => columnName(i + 1))
    columns.forEach((col, i) => {
      settle(f.SetCellValue('Sheet1', `${col}${50 + i}`, `M${i}`))
      settle(f.MergeCell('Sheet1', `${col}${50 + i}`, `${col}${90 + i}`))
    })
    settle(f.SetCellValue('Sheet1', 'A200', 'end'))
    await showWorkbook(saveWorkbook(f))
    const grid = screen.getByRole('grid', { name: 'Sheet1' })
    grid.scrollTop = 1_790
    fireEvent.scroll(grid)
    await flush()

    // Row 90 is at the top of the view. Every merge starts above the virtualizer's buffer and still reaches into the
    // view.
    expect(columns.filter((_, i) => screen.queryByText(`M${i}`))).toHaveLength(25)
  })

  it('clips charts and pictures that reach past the grid, so the scroll area does not grow', async () => {
    await showWorkbook(styledWorkbook(excelize))

    const content = screen.getByRole('grid', { name: 'Budget' }).firstElementChild
    expect(content?.className).toContain('overflow-clip')
  })

  it('leaves the grid without an active cell when every column it reaches is hidden', async () => {
    const f = excelize.NewFile()
    settle(f.SetCellValue('Sheet1', 'A1', 'hidden'))
    settle(f.SetColVisible('Sheet1', 'A:J', false))
    await showWorkbook(saveWorkbook(f))
    const grid = screen.getByRole('grid', { name: 'Sheet1' })

    expect(grid.hasAttribute('aria-activedescendant')).toBe(false)
    await act(() => void fireEvent.keyDown(grid, { key: 'ArrowRight' }))
    expect(grid.hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('freezes panes only while they fit the view', async () => {
    const frozenBlock = () => screen.getByRole('grid').querySelector('[style*="box-shadow"]')
    const freezing = (rows: number) => {
      const f = excelize.NewFile()
      settle(f.SetCellValue('Sheet1', 'A100', 'end'))
      settle(
        f.SetPanes('Sheet1', { Freeze: true, YSplit: rows, TopLeftCell: `A${rows + 1}`, ActivePane: 'bottomLeft' }),
      )
      return saveWorkbook(f)
    }

    await showWorkbook(freezing(2))
    expect(frozenBlock()).not.toBeNull()
    cleanup()
    // Forty 20px rows do not fit a 600px view: frozen, they would all mount and leave nothing to scroll.
    await showWorkbook(freezing(40))
    expect(frozenBlock()).toBeNull()
  })

  it('says a workbook too large to read is too large, not damaged, and keeps Download', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const tooLarge = (): PreviewClient => ({
      ...inProcessPreviewClient(engine)(),
      open: async () => {
        throw new WorkbookTooLargeError('Excelize used more than 536870912 bytes of memory.')
      },
    })
    try {
      const bytes = numberGrid(2, 2)
      await showWorkbook(bytes, tooLarge)

      expect(screen.getByText('This workbook is too large to preview')).toBeDefined()
      expect(screen.queryByText("This workbook can't be previewed")).toBeNull()
      expect(await clickDownload()).toEqual({ name: 'budget.xlsx', bytes })
    } finally {
      consoleError.mockRestore()
    }
  })

  it('says the preview could not load, not that the file is too large or damaged, when Excelize does not load', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const notLoaded = (): PreviewClient => ({
      ...inProcessPreviewClient(engine)(),
      open: async () => {
        throw new PreviewLoadError('The preview Worker did not load Excelize within 120 seconds.')
      },
    })
    try {
      await showWorkbook(numberGrid(2, 2), notLoaded)

      expect(screen.getByText("The preview couldn't load")).toBeDefined()
      expect(screen.queryByText('This workbook is too large to preview')).toBeNull()
      expect(screen.queryByText("This workbook can't be previewed")).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('shows the error state and stops the Worker when a read of rows fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const onClose = mock()
    const failingRows = (): PreviewClient => ({
      ...inProcessPreviewClient(engine, onClose)(),
      rows: async () => {
        throw new Error('Excelize used more memory than the Worker has')
      },
    })
    try {
      await showWorkbook(numberGrid(3, 3), failingRows)

      expect(screen.getByText("This workbook can't be previewed")).toBeDefined()
      expect(screen.queryByRole('grid')).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps the sheet on show when a read for a sheet the user left fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const { promise: budgetRows, reject } = Promise.withResolvers<RowsRead>()
    const slowBudget = (): PreviewClient => {
      const client = inProcessPreviewClient(engine)()
      return { ...client, rows: (index, from, to) => (index === 0 ? budgetRows : client.rows(index, from, to)) }
    }
    try {
      await showWorkbook(styledWorkbook(excelize), slowBudget)
      // Rows still being read are marked busy and greyed by a cover, not drawn as empty white cells.
      const loadingCover = '[aria-hidden="true"][class*="bg-[#f3f3f3]"]'
      const rows = screen.getByRole('grid', { name: 'Budget' }).querySelectorAll('[role="row"][aria-rowindex]')
      const bodyRows = [...rows].filter((row) => row.querySelector('[role="rowheader"]'))
      expect(bodyRows.length).toBeGreaterThan(0)
      expect(bodyRows.every((row) => row.getAttribute('aria-busy') === 'true' && row.querySelector(loadingCover))).toBe(
        true,
      )
      fireEvent.click(screen.getByRole('tab', { name: 'Notes' }))
      await flush()
      reject(new Error('The preview Worker failed'))
      await flush()

      const notes = screen.getByRole('grid', { name: 'Notes' })
      expect(within(notes).getByText('Second sheet')).toBeDefined()
      expect(notes.querySelector('[aria-busy]')).toBeNull()
      expect(notes.querySelector(loadingCover)).toBeNull()
      expect(screen.queryByText("This workbook can't be previewed")).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('says a sheet is too large to preview without reading it, and still shows the others', async () => {
    const createClient = reportingTooLarge([0])
    await showWorkbook(styledWorkbook(excelize), createClient)

    expect(screen.getByText('This sheet is too large to preview')).toBeDefined()
    expect(screen.queryByRole('grid')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }))
    await flush()
    expect(within(screen.getByRole('grid', { name: 'Notes' })).getByText('Second sheet')).toBeDefined()
  })

  it('gives no row or column count for a sheet too large to read, since it shows none of them', async () => {
    const f = excelize.NewFile()
    settle(
      f.SetSheetRow(
        'Sheet1',
        'A1',
        Array.from({ length: 51 }, (_, col) => col),
      ),
    )
    settle(
      f.SetSheetCol(
        'Sheet1',
        'A2',
        Array.from({ length: 5_000 }, (_, row) => row),
      ),
    )
    await showWorkbook(saveWorkbook(f), reportingTooLarge([0]))

    expect(screen.getByText('This sheet is too large to preview')).toBeDefined()
    expect(screen.queryByText(/^Rows after the first/)).toBeNull()
    expect(screen.queryByText(/^Columns after the first/)).toBeNull()
  })

  it('stops the Worker once no sheet is small enough to read', async () => {
    const onClose = mock()
    await showWorkbook(styledWorkbook(excelize), reportingTooLarge([0, 1], onClose))

    expect(screen.getByText('This sheet is too large to preview')).toBeDefined()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops the Worker for a workbook with no visible sheets', async () => {
    const onClose = mock()
    const parts = unzipSync(numberGrid(1, 1))
    parts['xl/workbook.xml'] = strToU8(
      strFromU8(parts['xl/workbook.xml']).replace('<sheet name="Sheet1"', '<sheet state="hidden" name="Sheet1"'),
    )
    await showWorkbook(zipSync(parts), inProcessPreviewClient(engine, onClose))

    expect(screen.getByText('This workbook has no visible sheets')).toBeDefined()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes the Worker when the preview closes', async () => {
    const onClose = mock()
    const { unmount } = await showWorkbook(numberGrid(2, 2), inProcessPreviewClient(engine, onClose))

    expect(onClose).not.toHaveBeenCalled()
    unmount()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says a workbook it cannot open cannot be previewed, stops the Worker, and Download still works', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const onClose = mock()
    const bytes = new TextEncoder().encode('not a workbook')
    try {
      await showWorkbook(bytes, inProcessPreviewClient(engine, onClose))

      expect(screen.getByText("This workbook can't be previewed")).toBeDefined()
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(await clickDownload()).toEqual({ name: 'budget.xlsx', bytes })
    } finally {
      consoleError.mockRestore()
    }
  })
})
