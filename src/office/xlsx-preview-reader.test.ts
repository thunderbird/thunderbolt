/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { xlsxPreviewLimits } from './constants'
import type { ExcelizeFile } from './excelize-engine'
import { WorkbookTooLargeError } from './xlsx-preview-client'
import { answerRequest, createPreviewReader, openPreviewWorkbook, settle } from './xlsx-preview-reader'
import {
  hostileProbeUrl,
  hostileWorkbook,
  loadTestEngine,
  longestCellText,
  saveWorkbook,
  styledWorkbook,
  tinyPng,
} from './xlsx-preview-test-runtime'

const engine = await loadTestEngine()
const { excelize } = engine
// Built once: every test only reads it.
const styled = styledWorkbook(excelize)

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`./test-fixtures/${name}`, import.meta.url)).arrayBuffer())

/** A saved workbook with one of its parts rewritten. */
const patched = (file: ExcelizeFile, part: string, rewrite: (xml: string) => string) => {
  const parts = unzipSync(saveWorkbook(file))
  parts[part] = strToU8(rewrite(strFromU8(parts[part])))
  return zipSync(parts)
}

describe('the spreadsheet preview reader', () => {
  it('lists the visible sheets with their used size, and what the preview leaves out', () => {
    const { overview } = openPreviewWorkbook(excelize, styled)

    expect(overview.sheets).toEqual([
      { name: 'Budget', rows: 7, cols: 5, tooLarge: false },
      { name: 'Notes', rows: 1, cols: 1, tooLarge: false },
    ])
    expect(overview.leftOut).toEqual({
      hiddenSheets: 1,
      chartSheets: 0,
      conditionalFormats: true,
      missingResults: 1,
      unsupportedCharts: 1,
      drawings: false,
      sparklines: false,
      longText: false,
    })
  })

  it('lays out a sheet: merges, frozen rows, hidden rows and columns, sizes, a picture and charts', () => {
    const layout = openPreviewWorkbook(excelize, styled).sheet(0)

    expect(layout.merges).toEqual([{ row: 0, col: 0, rows: 1, cols: 4 }])
    expect(layout.frozenRows).toBe(2)
    expect(layout.frozenCols).toBe(0)
    expect(layout.rows).not.toContain(6)
    expect(layout.cols).not.toContain(4)
    // Excelize reports widths in characters, which the preview draws at 7 pixels each.
    expect(layout.colWidths[0]).toBe(98)
    // Past the cells, the grid goes on to 30 rows and 10 columns, as Excel shows an empty grid.
    expect(layout.rows.length).toBeGreaterThanOrEqual(29)
    expect(layout.overlays.map(({ type }) => type)).toEqual(['image', 'chart', 'placeholder'])
    expect(layout.overlays[1]).toMatchObject({
      kind: 'column',
      title: 'Spend',
      // Excelize saves a chart with no values, so the range it points at is read instead.
      categories: ['Rent', 'Food'],
      series: [{ name: 'Amount', values: [1200, 450.5] }],
    })
    expect(layout.overlays[2]).toMatchObject({ kind: 'radar', title: 'Mix' })
  })

  it('grows a row with no stored height to its largest font, as Excel does, and keeps a stored height', () => {
    const f = excelize.NewFile()
    const large = settle(f.NewStyle({ Font: { Size: 20 } })).style
    settle(f.SetSheetRow('Sheet1', 'A1', ['Title', 'note']))
    settle(f.SetSheetRow('Sheet1', 'A2', ['Short row']))
    settle(f.SetSheetRow('Sheet1', 'A3', ['Plain']))
    settle(f.SetCellStyle('Sheet1', 'A1', 'A2', large))
    settle(f.SetRowHeight('Sheet1', 2, 12))
    const { rowHeights } = openPreviewWorkbook(excelize, saveWorkbook(f)).sheet(0)

    // 20 points is 26.7 px of text, in a row 1.3 times that.
    expect(rowHeights.slice(0, 3)).toEqual([35, 16, 20])
    // The styled workbook's 16-point title, saved by Excelize with no height.
    expect(openPreviewWorkbook(excelize, styled).sheet(0).rowHeights.slice(0, 2)).toEqual([28, 20])
  })

  it('reads rows as text in their number formats, aligned as Excel aligns them, with each style sent once', () => {
    const workbook = openPreviewWorkbook(excelize, styled)
    const first = workbook.rows(0, 0, 6)

    const cellsOf = (row: number) => first.rows.find((r) => r.row === row)?.cells ?? []
    expect(cellsOf(2)).toEqual([
      { col: 0, text: 'Rent', style: 0, align: undefined, link: undefined },
      { col: 1, text: '1-Jan-2026', style: 3, align: 'end', link: undefined },
      { col: 2, text: '$1,200.00', style: 2, align: 'end', link: undefined },
      { col: 3, text: '25.0%', style: 4, align: 'end', link: undefined },
    ])
    expect(cellsOf(5)).toEqual([{ col: 0, text: 'Docs', style: 0, align: undefined, link: true }])
    expect(first.styles.map(([id]) => id).sort()).toEqual([0, 1, 2, 3, 4])
    expect(first.styles.find(([id]) => id === 1)?.[1].Fill?.Color).toEqual(['1F3864'])
    expect(workbook.rows(0, 0, 6).styles).toEqual([])
  })

  it('names the type of each chart: six drawn as SVG, the rest as placeholders', () => {
    const f = excelize.NewFile()
    settle(f.SetSheetRow('Sheet1', 'A1', ['Q1', 4]))
    const types = [
      excelize.Col,
      excelize.Bar,
      excelize.Line,
      excelize.Area,
      excelize.Pie,
      excelize.Doughnut,
      excelize.Scatter,
      excelize.Radar,
      excelize.Col3D,
    ]
    types.forEach((type, i) =>
      settle(f.AddChart('Sheet1', `D${i * 20 + 1}`, { Type: type, Series: [{ Values: 'Sheet1!$B$1:$B$1' }] })),
    )
    const layout = openPreviewWorkbook(excelize, saveWorkbook(f)).sheet(0)

    expect(layout.overlays.map((overlay) => [overlay.type, 'kind' in overlay ? overlay.kind : ''])).toEqual([
      ['chart', 'column'],
      ['chart', 'bar'],
      ['chart', 'line'],
      ['chart', 'area'],
      ['chart', 'pie'],
      ['chart', 'doughnut'],
      ['placeholder', 'scatter'],
      ['placeholder', 'radar'],
      ['placeholder', 'threeD'],
    ])
  })

  it('reads at most the sheet’s budget of values for a chart over a huge range, and counts it as cut', () => {
    const f = excelize.NewFile()
    settle(f.SetSheetRow('Sheet1', 'A1', ['Q1', 4]))
    settle(f.AddChart('Sheet1', 'D1', { Type: excelize.Line, Series: [{ Values: 'Sheet1!$B$1:$Z$1048576' }] }))
    // A small budget, so the range is read cell by cell no further than it allows.
    const layout = openPreviewWorkbook(excelize, saveWorkbook(f), { ...xlsxPreviewLimits, chartPoints: 100 }).sheet(0)
    const [chart] = layout.overlays

    expect(chart).toMatchObject({ type: 'chart', kind: 'line' })
    expect(chart.type === 'chart' && chart.series[0].values).toHaveLength(100)
    expect(layout.leftOutObjects).toBe(1)
  })

  it('draws a chart claiming a million saved points up to the budget, and counts it as cut', () => {
    const f = excelize.NewFile()
    settle(f.SetSheetRow('Sheet1', 'A1', ['Q1', 4]))
    settle(f.AddChart('Sheet1', 'D1', { Type: excelize.Line, Series: [{ Values: 'Sheet1!$B$1:$B$1' }] }))
    const hostile =
      '<numCache><ptCount val="1000000"></ptCount><pt idx="0"><v>2</v></pt><pt idx="999999"><v>9</v></pt>' +
      '<pt idx="-3"><v>9</v></pt><pt idx="1.5"><v>9</v></pt></numCache>'
    const bytes = patched(f, 'xl/charts/chart1.xml', (xml) => xml.replace(/<numCache>.*?<\/numCache>/, hostile))
    const layout = openPreviewWorkbook(excelize, bytes).sheet(0)
    const [chart] = layout.overlays

    const values = chart.type === 'chart' ? chart.series[0].values : []
    expect(values).toHaveLength(xlsxPreviewLimits.chartPoints)
    expect(values[0]).toBe(2)
    expect(values.filter((value) => value !== 0)).toEqual([2])
    expect(layout.leftOutObjects).toBe(1)
  })

  it('drops a picture anchored 900 million rows down, without counting the rows one by one', () => {
    const f = excelize.NewFile()
    settle(
      f.AddPictureFromBytes('Sheet1', 'A1', {
        Extension: '.png',
        File: tinyPng,
        Format: {},
        InsertType: excelize.PictureInsertTypePlaceOverCells,
      }),
    )
    const bytes = patched(f, 'xl/drawings/drawing1.xml', (xml) =>
      xml.replaceAll('<xdr:row>0</xdr:row>', '<xdr:row>900000000</xdr:row>'),
    )
    const layout = openPreviewWorkbook(excelize, bytes).sheet(0)
    const inGrid = openPreviewWorkbook(excelize, saveWorkbook(f)).sheet(0)

    expect(layout.rows).toHaveLength(xlsxPreviewLimits.rows)
    expect(layout.overlays).toEqual([])
    // Left out, so the banner says so.
    expect(layout.leftOutObjects).toBe(1)
    expect(inGrid.overlays).toHaveLength(1)
  })

  it('draws a chart from the values Excel saved in it when it saved them', async () => {
    const parts = unzipSync(await fixture('WithChart.xlsx'))
    // Change the cells, so values read from the range would differ from the saved ones.
    parts['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(parts['xl/worksheets/sheet1.xml']).replace(/<v>1<\/v>/, '<v>100</v>'),
    )
    const layout = openPreviewWorkbook(excelize, zipSync(parts)).sheet(1)

    expect(layout.overlays[0]).toMatchObject({
      type: 'chart',
      kind: 'line',
      series: [
        { name: '1st Column', values: [1, 2, 3, 4, 5, 6] },
        { name: '2nd Column', values: [10, 12, 14, 9, 15, 17] },
      ],
    })
  })

  it('counts a formula with no saved result, but not one whose saved result is empty text', () => {
    const f = excelize.NewFile()
    settle(f.SetCellFormula('Sheet1', 'A1', '""'))
    settle(f.SetCellFormula('Sheet1', 'A2', '""'))
    const sheet = 'xl/worksheets/sheet1.xml'
    const missing = (bytes: Uint8Array) => openPreviewWorkbook(excelize, bytes).overview.leftOut.missingResults

    expect(missing(saveWorkbook(f))).toBe(2)
    const emptyResults = (xml: string) =>
      xml.replace('</f></c></row><row r="2">', '</f><v></v></c></row><row r="2">').replace('</f></c>', '</f><v/></c>')
    expect(missing(patched(f, sheet, emptyResults))).toBe(0)
  })

  it('notes long text in an inline string, not only in the shared strings', () => {
    const f = excelize.NewFile()
    const inline = `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(1_001)}</t></is></c></row></sheetData>`
    const bytes = patched(f, 'xl/worksheets/sheet1.xml', (xml) => xml.replace('<sheetData></sheetData>', inline))
    const shortText = patched(f, 'xl/worksheets/sheet1.xml', (xml) =>
      xml.replace('<sheetData></sheetData>', inline.replace('x'.repeat(1_001), '&amp;'.repeat(500))),
    )

    expect(openPreviewWorkbook(excelize, bytes).overview.leftOut.longText).toBe(true)
    // Escaped, the text is 2,500 characters; read, it is 500.
    expect(openPreviewWorkbook(excelize, shortText).overview.leftOut.longText).toBe(false)
  })

  it('keeps hostile text as text, never reads a linked picture, and cuts a 32,767-character cell', () => {
    const workbook = openPreviewWorkbook(excelize, hostileWorkbook(excelize))
    const layout = workbook.sheet(0)
    const { rows } = workbook.rows(0, 0, 30)
    const cells = rows.flatMap((row) => row.cells)

    expect(workbook.overview.sheets[0].name).toBe('<img src=x onerror=alert(1)>')
    expect(workbook.overview.leftOut.longText).toBe(true)
    expect(cells.map(({ text }) => text)).toContain('<script>window.__xlsxProbe=1</script>')
    expect(cells.find(({ text }) => text === 'click me')).toMatchObject({ link: true })
    const long = cells.find(({ text }) => text.startsWith('LLL'))
    expect(long?.text).toBe(`${longestCellText.slice(0, xlsxPreviewLimits.cellChars)}…`)
    // The PNG and the embedded SVG come back as bytes; the linked picture is not there at all.
    expect(layout.overlays.filter(({ type }) => type === 'image')).toHaveLength(2)
    const sent = JSON.stringify({ layout: { ...layout, overlays: layout.overlays.length }, rows })
    expect(sent).not.toContain(hostileProbeUrl)
    expect(sent).not.toContain('javascript:')
  })

  it('stops the grid at the row and column caps', () => {
    const f = excelize.NewFile()
    for (let row = 1; row <= 40; row++) {
      settle(
        f.SetSheetRow(
          'Sheet1',
          `A${row}`,
          Array.from({ length: 12 }, (_, col) => row * 100 + col),
        ),
      )
    }
    // 520 row and cell tags, under twice the 25 × 11 the grid shows.
    const limits = { ...xlsxPreviewLimits, rows: 25, columns: 11 }
    const workbook = openPreviewWorkbook(excelize, saveWorkbook(f), limits)
    const layout = workbook.sheet(0)

    expect(workbook.overview.sheets[0]).toEqual({ name: 'Sheet1', rows: 40, cols: 12, tooLarge: false })
    expect(layout.rows).toHaveLength(25)
    expect(layout.cols).toHaveLength(11)
    expect(workbook.rows(0, 24, 40).rows.map(({ row }) => row)).toEqual([24])
  })

  it('reads a workbook whose writer left out the styles part, drawing its cells plain', () => {
    const f = excelize.NewFile()
    settle(f.SetSheetRow('Sheet1', 'A1', ['Item', 12]))
    const parts = unzipSync(saveWorkbook(f))
    delete parts['xl/styles.xml']
    const { rows, styles } = openPreviewWorkbook(excelize, zipSync(parts)).rows(0, 0, 3)

    expect(rows.flatMap(({ cells }) => cells.map(({ text }) => text))).toEqual(['Item', '12'])
    expect(styles).toEqual([[0, {}]])
  })

  it('fails on a cell whose style the file does not define, rather than drawing it plain', () => {
    const bytes = withSheetData('<row r="1"><c r="A1" s="999999"><v>1</v></c></row>')

    expect(() => openPreviewWorkbook(excelize, bytes).rows(0, 0, 1)).toThrow()
  })

  it('refuses a workbook that unzips past the ceiling, and a file that is not a workbook', () => {
    const bytes = styled

    expect(() => openPreviewWorkbook(excelize, bytes, { ...xlsxPreviewLimits, unzipBytes: 1024 })).toThrow()
    expect(() => openPreviewWorkbook(excelize, new TextEncoder().encode('not a zip'))).toThrow()
  })
})

/** A one-sheet workbook whose cells are this XML, as a writer other than Excelize might put them. */
const withSheetData = (sheetData: string) =>
  patched(excelize.NewFile(), 'xl/worksheets/sheet1.xml', (xml) =>
    xml.replace('<sheetData></sheetData>', `<sheetData>${sheetData}</sheetData>`),
  )

/** A workbook with `anchors` copies of a column chart of `series` series, each saving this `numCache` content. */
const chartWithCache = (cache: string, series = 1, anchors = 1) => {
  const f = excelize.NewFile()
  settle(f.SetSheetRow('Sheet1', 'A1', ['Q1', 4]))
  settle(f.AddChart('Sheet1', 'D2', { Type: excelize.Col, Series: [{ Values: 'Sheet1!$B$1:$B$1' }] }))
  const parts = unzipSync(saveWorkbook(f))
  const chart = strFromU8(parts['xl/charts/chart1.xml'])
  const ser = /<ser>[\s\S]*?<\/ser>/.exec(chart)?.[0] ?? ''
  const cached = ser.replace(/<numCache>[\s\S]*?<\/numCache>/, `<numCache>${cache}</numCache>`)
  parts['xl/charts/chart1.xml'] = strToU8(chart.replace(ser, cached.repeat(series)))
  const drawing = strFromU8(parts['xl/drawings/drawing1.xml'])
  const anchor = /<xdr:twoCellAnchor>[\s\S]*?<\/xdr:twoCellAnchor>/.exec(drawing)?.[0] ?? ''
  parts['xl/drawings/drawing1.xml'] = strToU8(drawing.replace(anchor, anchor.repeat(anchors)))
  return zipSync(parts)
}

const points = (count: number) =>
  `<ptCount val="${count}"></ptCount>${Array.from({ length: count }, (_, i) => `<pt idx="${i}"><v>${i}</v></pt>`).join('')}`

describe('the spreadsheet preview reader on adversarial workbooks', () => {
  it('sizes saved chart values by the points the file holds, not the count it claims', () => {
    const sparse = chartWithCache('<ptCount val="5000"></ptCount><pt idx="0"><v>7</v></pt>', 200)
    const [chart] = openPreviewWorkbook(excelize, sparse).sheet(0).overlays

    // 200 series of one point each, not 200 of 5,000.
    expect(chart.type === 'chart' && chart.series.map(({ values }) => values)).toEqual(
      Array.from({ length: 200 }, () => [7]),
    )
  })

  it('shares one budget of 20,000 values among the charts of a sheet, and counts a chart it cuts', () => {
    const layout = openPreviewWorkbook(excelize, chartWithCache(points(2_000), 6, 2)).sheet(0)
    const lengths = layout.overlays.map(
      (chart) => chart.type === 'chart' && chart.series.map(({ values }) => values.length),
    )

    expect(lengths).toEqual([Array(6).fill(2_000), Array(4).fill(2_000)])
    expect(layout.leftOutObjects).toBe(1)
  })

  it('draws saved values past 5,000 in full, within the sheet’s budget, and counts the series it cuts', () => {
    // A budget of 5,001: the first series fills it, past the old 5,000 cap, and the second is cut.
    const limits = { ...xlsxPreviewLimits, chartPoints: 5_001 }
    const layout = openPreviewWorkbook(excelize, chartWithCache(points(5_001), 2), limits).sheet(0)
    const [chart] = layout.overlays

    expect(chart.type === 'chart' && chart.series.map(({ values }) => values.length)).toEqual([5_001])
    expect(layout.leftOutObjects).toBe(1)
  })

  it('draws at most 50 charts and pictures on a sheet, and counts the rest', () => {
    const layout = openPreviewWorkbook(excelize, chartWithCache('<pt idx="0"><v>1</v></pt>', 1, 60)).sheet(0)

    expect(layout.overlays).toHaveLength(50)
    expect(layout.leftOutObjects).toBe(10)
  })

  it('counts a chart anchored past the row cap, which a sheet with one cell would otherwise hide', () => {
    const f = excelize.NewFile()
    settle(f.SetCellValue('Sheet1', 'A1', 10))
    settle(f.AddChart('Sheet1', 'A6001', { Type: excelize.Col, Series: [{ Values: 'Sheet1!$A$1:$A$1' }] }))
    const layout = openPreviewWorkbook(excelize, saveWorkbook(f)).sheet(0)

    expect(layout.overlays).toEqual([])
    expect(layout.leftOutObjects).toBe(1)
  })

  it('names a stacked chart: columns drawn stacked, stacked areas as a placeholder', () => {
    const f = excelize.NewFile()
    settle(f.SetSheetRow('Sheet1', 'A1', ['Q1', 10, 20]))
    const series = [{ Values: 'Sheet1!$B$1:$B$1' }, { Values: 'Sheet1!$C$1:$C$1' }]
    settle(f.AddChart('Sheet1', 'E1', { Type: excelize.ColStacked, Series: series }))
    settle(f.AddChart('Sheet1', 'E20', { Type: excelize.ColPercentStacked, Series: series }))
    settle(f.AddChart('Sheet1', 'E40', { Type: excelize.AreaStacked, Series: series }))
    const { overlays } = openPreviewWorkbook(excelize, saveWorkbook(f)).sheet(0)

    expect(overlays.map((overlay) => [overlay.type, 'kind' in overlay ? overlay.kind : ''])).toEqual([
      ['chart', 'column'],
      ['chart', 'column'],
      ['placeholder', 'stackedArea'],
    ])
    expect(overlays.map((overlay) => overlay.type === 'chart' && overlay.stacking)).toEqual([
      'stacked',
      'percent',
      false,
    ])
  })

  it('names an Excel 2016 chart by the layouts of all its series', () => {
    const chartExOf = (series: string) => {
      const f = excelize.NewFile()
      settle(f.AddChart('Sheet1', 'D2', { Type: excelize.Col, Series: [{ Values: 'Sheet1!$B$1:$B$1' }] }))
      const chartEx =
        '<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart><cx:plotArea>' +
        `<cx:plotAreaRegion>${series}</cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`
      return openPreviewWorkbook(
        excelize,
        patched(f, 'xl/charts/chart1.xml', () => chartEx),
      ).sheet(0).overlays[0]
    }

    expect(chartExOf('<cx:series layoutId="waterfall"/>')).toMatchObject({ type: 'placeholder', kind: 'waterfall' })
    // A Pareto chart is a histogram's columns plus the Pareto line.
    expect(chartExOf('<cx:series layoutId="clusteredColumn"/><cx:series layoutId="paretoLine"/>')).toMatchObject({
      type: 'placeholder',
      kind: 'pareto',
    })
  })

  it('reads cells whose attributes use single quotes, as XML allows', () => {
    const bytes = withSheetData(
      `<row r='1'><c r='A1' t='inlineStr'><is><t>visible text</t></is></c><c r='B1'><v>1.5</v></c></row>`,
    )
    const workbook = openPreviewWorkbook(excelize, bytes)

    expect(workbook.overview.sheets[0]).toMatchObject({ rows: 1, cols: 2 })
    expect(workbook.rows(0, 0, 1).rows[0].cells.map(({ text }) => text)).toEqual(['visible text', '1.5'])
  })

  it('counts cells written without a reference, and refuses a sheet past twice the cells it shows', () => {
    const row = `<row>${'<c><v>1</v></c>'.repeat(12)}</row>`
    const limits = { ...xlsxPreviewLimits, rows: 10, columns: 10 }
    const small = openPreviewWorkbook(excelize, withSheetData(row.repeat(5)), limits)
    const large = openPreviewWorkbook(excelize, withSheetData(row.repeat(20)), limits)

    expect(small.overview.sheets[0]).toEqual({ name: 'Sheet1', rows: 5, cols: 12, tooLarge: false })
    expect(large.overview.sheets[0].tooLarge).toBe(true)
    expect(() => large.sheet(0)).toThrow(WorkbookTooLargeError)
  })

  it('counts row tags, with or without a reference, and merged ranges when it decides a sheet is too large', () => {
    const limits = { ...xlsxPreviewLimits, rows: 10, columns: 10 }
    const emptyRows = openPreviewWorkbook(excelize, withSheetData('<row/>'.repeat(201)), limits)
    const merges = `<mergeCells>${'<mergeCell ref="A1:A2"/>'.repeat(xlsxPreviewLimits.merges + 1)}</mergeCells>`
    const merged = patched(excelize.NewFile(), 'xl/worksheets/sheet1.xml', (xml) =>
      xml.replace('<sheetData></sheetData>', `<sheetData></sheetData>${merges}`),
    )

    expect(emptyRows.overview.sheets[0].tooLarge).toBe(true)
    expect(openPreviewWorkbook(excelize, merged).overview.sheets[0].tooLarge).toBe(true)
  })

  it('scans a run of unclosed tags once, not again from each of them', () => {
    const f = excelize.NewFile()
    settle(f.SetCellValue('Sheet1', 'A1', 'shared'))
    const parts = unzipSync(saveWorkbook(f))
    const unclosed = (part: string, rewrite: (xml: string) => string) => {
      parts[part] = strToU8(rewrite(strFromU8(parts[part])))
    }
    // Outside any comment, which the scans leave out, and ending in comments that never close.
    unclosed('xl/worksheets/sheet1.xml', (xml) =>
      xml.replace(
        '<sheetData>',
        `${'<c '.repeat(100_000)}${'<row '.repeat(100_000)}<sheetData>${'<!--'.repeat(100_000)}`,
      ),
    )
    unclosed('xl/sharedStrings.xml', (xml) => xml.replace('</sst>', `${'<si>'.repeat(100_000)}</sst>`))
    const started = performance.now()
    // The scans run when the workbook opens; Excelize, which would refuse such a sheet, has not parsed it yet.
    openPreviewWorkbook(excelize, zipSync(parts))

    // Quadratic scans took minutes on this.
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('fails on a cell Excelize cannot read, rather than showing it blank', () => {
    const bytes = withSheetData('<row r="1"><c r="A1" t="s"><v>999999</v></c></row>')

    expect(() => openPreviewWorkbook(excelize, bytes).rows(0, 0, 1)).toThrow('invalid shared string index')
  })

  it('resolves theme colours, with their tints, for fonts, fills and borders', () => {
    const f = excelize.NewFile()
    const fill = { Type: 'pattern', Pattern: 1, Color: ['#000000'] }
    const border = [{ Type: 'left', Style: 1, Color: '#000000' }]
    const white = settle(f.NewStyle({ Font: { ColorTheme: 0 }, Fill: fill, Border: border })).style
    const tinted = settle(f.NewStyle({ Font: { ColorTheme: 4, ColorTint: -0.5 } })).style
    settle(f.SetSheetRow('Sheet1', 'A1', ['white', 'tinted']))
    settle(f.SetCellStyle('Sheet1', 'A1', 'A1', white))
    settle(f.SetCellStyle('Sheet1', 'B1', 'B1', tinted))
    const bytes = patched(f, 'xl/styles.xml', (xml) =>
      xml
        .replace('<fgColor rgb="FF000000">', '<fgColor theme="4" tint="-0.5">')
        .replace('<left style="thin"><color rgb="FF000000">', '<left style="thin"><color theme="5">'),
    )
    const { styles } = openPreviewWorkbook(excelize, bytes).rows(0, 0, 1)
    const styleOf = (id: number) => styles.find(([styleId]) => styleId === id)?.[1]

    expect(styleOf(white)?.Font?.Color).toBe('FFFFFF')
    expect(styleOf(tinted)?.Font?.Color?.toUpperCase()).toBe('FF1F4E79')
    expect(styleOf(white)?.Fill?.Color).toEqual(['1F4E79'])
    expect(styleOf(white)?.Border?.[0].Color).toBe('ED7D31')
  })

  it('draws a merge whose first cell is hidden as separate cells, so the focus never targets a hidden cell', () => {
    const f = excelize.NewFile()
    settle(f.SetCellValue('Sheet1', 'A1', 'merged'))
    settle(f.MergeCell('Sheet1', 'A1', 'C1'))
    settle(f.SetColVisible('Sheet1', 'A', false))

    expect(openPreviewWorkbook(excelize, saveWorkbook(f)).sheet(0).merges).toEqual([])
  })

  it('keeps a row height within Excel’s maximum of 409 points', () => {
    const bytes = withSheetData('<row r="1" ht="1000000000" customHeight="1"><c r="A1"><v>1</v></c></row>')

    expect(openPreviewWorkbook(excelize, bytes).sheet(0).rowHeights[0]).toBe(545)
  })

  it('fails a call after which Excelize holds more memory than the preview allows, and answers it as too large', () => {
    const reader = createPreviewReader(engine, 1)

    expect(() => reader.open(styled)).toThrow(WorkbookTooLargeError)
    expect(answerRequest(reader, { id: 7, call: 'open', args: [styled] })).toMatchObject({
      id: 7,
      tooLarge: true,
    })
    // Any other failure says nothing about size.
    expect(answerRequest(createPreviewReader(engine), { id: 8, call: 'sheet', args: [0] })).toEqual({
      id: 8,
      error: 'Error: No workbook is open.',
    })
  })

  it('treats any failure once Excelize is past its memory ceiling as a workbook too large, as when its runtime dies', () => {
    // At WebAssembly's 4 GiB Go's calls return nothing, and the reader fails on that with a TypeError.
    expect(() => createPreviewReader(engine, 1).open(new TextEncoder().encode('not a zip'))).toThrow(
      WorkbookTooLargeError,
    )
  })

  it('refuses a workbook whose parts unzip past the bound before Excelize opens it, pictures aside', () => {
    const f = excelize.NewFile()
    settle(f.SetCellValue('Sheet1', 'A1', 'text'))
    const parts = unzipSync(saveWorkbook(f))
    const total = Object.values(parts).reduce((sum, part) => sum + part.length, 0)
    const limits = { ...xlsxPreviewLimits, partBytes: total + 1_000 }
    const opened: Uint8Array[] = []
    const watched = {
      ...excelize,
      OpenReader: (...args: Parameters<typeof excelize.OpenReader>) => {
        opened.push(args[0])
        return excelize.OpenReader(...args)
      },
    }
    const picture = zipSync({ ...parts, 'xl/media/image1.png': new Uint8Array(5_000) })
    // Shared strings Excelize would load, kept under the media folder to pass for a picture.
    const rels = 'xl/_rels/workbook.xml.rels'
    const strings = zipSync({
      ...parts,
      [rels]: strToU8(strFromU8(parts[rels]).replace(/Target="[^"]*sharedStrings\.xml"/, 'Target="media/strings.xml"')),
      'xl/media/strings.xml': strToU8(
        strFromU8(parts['xl/sharedStrings.xml']).replace('</sst>', `<!--${' '.repeat(5_000)}--></sst>`),
      ),
    })

    expect(openPreviewWorkbook(watched, picture, limits).overview.sheets).toHaveLength(1)
    expect(() => openPreviewWorkbook(watched, strings, limits)).toThrow(WorkbookTooLargeError)
    expect(opened).toEqual([picture])
  })

  it('counts the cells Excelize fills in: each row out to its last cell, and the sheet out to its last row', () => {
    const limits = { ...xlsxPreviewLimits, rows: 10, columns: 10 }
    const tooLargeOf = (sheetData: string) =>
      openPreviewWorkbook(excelize, withSheetData(sheetData), limits).overview.sheets[0].tooLarge

    // Twice 10 × 10 is 200: a hundred cells fit; one cell at column 200 or at row 201 does not.
    expect(tooLargeOf(`<row r="1">${'<c><v>1</v></c>'.repeat(99)}</row>`)).toBe(false)
    expect(tooLargeOf('<row r="1"><c r="GR1"><v>1</v></c></row>')).toBe(true)
    expect(tooLargeOf('<row r="201"><c r="A201"><v>1</v></c></row>')).toBe(true)
  })

  it('refuses as damaged a workbook that Excelize could read differently from the preview’s scan', () => {
    const f = excelize.NewFile()
    settle(f.NewSheet('Other'))
    const parts = unzipSync(saveWorkbook(f))
    const rels = 'xl/_rels/workbook.xml.rels'
    const workbookXml = 'xl/workbook.xml'
    const duplicateId = zipSync({
      ...parts,
      [rels]: strToU8(
        strFromU8(parts[rels]).replace(
          '</Relationships>',
          '<Relationship Id="rId1" Target="worksheets/sheet2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
        ),
      ),
    })
    const sameName = zipSync({
      ...parts,
      [workbookXml]: strToU8(strFromU8(parts[workbookXml]).replace('name="Other"', 'name="SHEET1"')),
    })
    const backslash = zipSync({ ...parts, 'xl\\worksheets\\sheet1.xml': parts['xl/worksheets/sheet1.xml'] })

    for (const bytes of [duplicateId, sameName, backslash]) {
      const error = (() => {
        try {
          openPreviewWorkbook(excelize, bytes)
        } catch (thrown) {
          return thrown
        }
      })()
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(WorkbookTooLargeError)
    }
  })

  it('reads an ordinary workbook whose links and defined names pass 2 MiB, the bound on parsed parts', () => {
    const f = excelize.NewFile()
    settle(f.SetCellValue('Sheet1', 'A1', 'links'))
    const parts = unzipSync(saveWorkbook(f))
    // A thousand long links and long names: past 2 MiB each, with fewer elements for Excelize to parse.
    const links = Array.from(
      { length: 1_000 },
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://crm.example.com/customers/${100_000 + i}?view=${'x'.repeat(2_200)}" TargetMode="External"/>`,
    ).join('')
    const names = Array.from(
      { length: 1_000 },
      (_, i) => `<definedName name="Range_${i}">${Array(130).fill('Sheet1!$A$1:$C$1').join(',')}</definedName>`,
    )
    expect(Math.min(links.length, names.join('').length)).toBeGreaterThan(xlsxPreviewLimits.xmlPartBytes)
    const bytes = zipSync(
      {
        ...parts,
        'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links}</Relationships>`,
        ),
        'xl/workbook.xml': strToU8(
          strFromU8(parts['xl/workbook.xml']).replace(
            '</sheets>',
            `</sheets><definedNames>${names.join('')}</definedNames>`,
          ),
        ),
      },
      // Stored, not deflated: compressing megabytes costs the test more than reading them.
      { level: 0 },
    )
    const workbook = openPreviewWorkbook(excelize, bytes)

    expect(workbook.overview.sheets).toEqual([{ name: 'Sheet1', rows: 1, cols: 1, tooLarge: false }])
    expect(workbook.rows(0, 0, 1).rows[0].cells[0].text).toBe('links')
  })

  it('charges an empty chart series against the budget, so 20,001 of them cannot all be drawn', () => {
    const f = excelize.NewFile()
    settle(f.SetCellValue('Sheet1', 'A1', 1))
    settle(f.AddChart('Sheet1', 'D2', { Type: excelize.Line, Series: [{ Values: 'Sheet1!$A$1:$A$1' }] }))
    const bytes = patched(f, 'xl/charts/chart1.xml', (xml) =>
      xml.replace(/<ser>[\s\S]*<\/ser>/, '<ser><val/></ser>'.repeat(20_001)),
    )
    const layout = openPreviewWorkbook(excelize, bytes).sheet(0)
    const [chart] = layout.overlays

    expect(chart.type === 'chart' && chart.series).toHaveLength(xlsxPreviewLimits.chartPoints)
    expect(layout.leftOutObjects).toBe(1)
  })

  it('counts no missing result for a sparkline after a self-closing sheetData', () => {
    const ext =
      '<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">' +
      '<x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup><x14:sparklines>' +
      '<x14:sparkline><xm:f>Sheet1!A1:A2</xm:f><xm:sqref>B1</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup>' +
      '</x14:sparklineGroups></ext></extLst>'
    const bytes = patched(excelize.NewFile(), 'xl/worksheets/sheet1.xml', (xml) =>
      xml.replace('<sheetData></sheetData>', '<sheetData/>').replace('</worksheet>', `${ext}</worksheet>`),
    )

    expect(openPreviewWorkbook(excelize, bytes).overview.leftOut.missingResults).toBe(0)
  })

  it('draws a placeholder for a chart reading a sheet the scan did not take for a worksheet, though Excelize reads it', () => {
    const f = excelize.NewFile()
    settle(f.NewSheet('Data'))
    settle(f.SetCellValue('Data', 'A1', 7))
    settle(f.AddChart('Sheet1', 'D2', { Type: excelize.Col, Series: [{ Values: 'Data!$A$1:$A$1' }] }))
    const bytes = patched(f, 'xl/_rels/workbook.xml.rels', (xml) =>
      xml.replace(/(<Relationship\b[^>]*Target="[^"]*sheet2\.xml"[^>]*>)/, (tag) =>
        tag.replace('/worksheet"', '/unrecognized"'),
      ),
    )
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const workbook = openPreviewWorkbook(excelize, bytes)
    const [chart] = workbook.sheet(0).overlays
    consoleError.mockRestore()

    expect(settle(settle(excelize.OpenReader(bytes)).GetCellValue('Data', 'A1')).value).toBe('7')
    expect(workbook.overview.sheets.map(({ name }) => name)).toEqual(['Sheet1'])
    expect(chart.type).toBe('placeholder')
  })

  it('marks a sheet too large when a drawing part is past the bound, and draws a placeholder for a chart part past it', () => {
    // Inside the root element, so the part still parses once the bound is lifted.
    const pad = (xml: string) =>
      xml.replace(/<\/[^<]*$/, (end) => `${' '.repeat(xlsxPreviewLimits.xmlPartBytes)}${end}`)
    const withChart = () => {
      const f = excelize.NewFile()
      settle(f.SetCellValue('Sheet1', 'A1', 4))
      settle(f.AddChart('Sheet1', 'D2', { Type: excelize.Col, Series: [{ Values: 'Sheet1!$A$1:$A$1' }] }))
      return f
    }
    const bigDrawing = openPreviewWorkbook(excelize, patched(withChart(), 'xl/drawings/drawing1.xml', pad))
    const bigChart = openPreviewWorkbook(excelize, patched(withChart(), 'xl/charts/chart1.xml', pad))
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})

    expect(bigDrawing.overview.sheets[0].tooLarge).toBe(true)
    expect(bigChart.sheet(0).overlays[0]).toMatchObject({ type: 'placeholder', kind: 'other' })
    consoleError.mockRestore()
  })

  it('draws a placeholder for a chart that reads a sheet too large or no worksheet, and reads a small hidden one', () => {
    const f = excelize.NewFile()
    settle(f.NewSheet('Huge'))
    settle(f.NewSheet('Small'))
    settle(f.SetCellValue('Sheet1', 'A1', 4))
    settle(f.SetCellValue('Small', 'A1', 6))
    settle(f.SetSheetVisible('Small', false))
    settle(
      f.SetSheetRow(
        'Huge',
        'A1',
        Array.from({ length: 210 }, (_, i) => i),
      ),
    )
    settle(f.SetSheetVisible('Huge', false))
    const chartOn = (range: string) => ({ Type: excelize.Col, Series: [{ Values: range }] })
    settle(f.AddChart('Sheet1', 'A2', chartOn('Huge!$A$1:$A$1')))
    settle(f.AddChart('Sheet1', 'D2', chartOn('Nowhere!$A$1:$A$1')))
    settle(f.AddChart('Sheet1', 'G2', chartOn('sheet1!$A$1:$A$1')))
    settle(f.AddChart('Sheet1', 'J2', chartOn('Small!$A$1:$A$1')))
    // Huge's 211 row and cell tags are past twice the 10 × 10 the grid shows.
    const limits = { ...xlsxPreviewLimits, rows: 10, columns: 10 }
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const overlays = openPreviewWorkbook(excelize, saveWorkbook(f), limits).sheet(0).overlays
    consoleError.mockRestore()

    // Excelize names sheets case-insensitively, so `sheet1` is Sheet1.
    expect(overlays.map(({ type }) => type)).toEqual(['placeholder', 'placeholder', 'chart', 'chart'])
  })

  it('applies a font’s tint to an RGB colour too', () => {
    const f = excelize.NewFile()
    const tinted = settle(f.NewStyle({ Font: { Color: '#000000', ColorTint: 0.5 } })).style
    settle(f.SetCellValue('Sheet1', 'A1', 'grey'))
    settle(f.SetCellStyle('Sheet1', 'A1', 'A1', tinted))
    const { styles } = openPreviewWorkbook(excelize, saveWorkbook(f)).rows(0, 0, 1)

    expect(styles.find(([id]) => id === tinted)?.[1].Font?.Color?.toUpperCase()).toBe('FF808080')
  })

  it('draws a value that is not a finite number as zero, so one cell cannot blank a chart', () => {
    const cache =
      '<ptCount val="3"></ptCount><pt idx="0"><v>Infinity</v></pt><pt idx="1"><v>1e999</v></pt><pt idx="2"><v>5</v></pt>'
    const [chart] = openPreviewWorkbook(excelize, chartWithCache(cache)).sheet(0).overlays

    expect(chart.type === 'chart' && chart.series[0].values).toEqual([0, 0, 5])
  })

  it('counts only the formulas of cells as missing results, not those of sparklines and extensions', () => {
    const ext =
      '<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">' +
      '<x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup><x14:sparklines>' +
      '<x14:sparkline><xm:f>Sheet1!A1:A2</xm:f><xm:sqref>B1</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup>' +
      '</x14:sparklineGroups></ext></extLst>'
    const bytes = patched(excelize.NewFile(), 'xl/worksheets/sheet1.xml', (xml) =>
      xml
        .replace('<sheetData></sheetData>', '<sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData>')
        .replace('</worksheet>', `${ext}</worksheet>`),
    )

    expect(openPreviewWorkbook(excelize, bytes).overview.leftOut.missingResults).toBe(1)
  })

  it('leaves XML comments out of every scan, so commented rows, cells, merges and sheets change nothing', () => {
    const f = excelize.NewFile()
    const large = settle(f.NewStyle({ Font: { Size: 72 } })).style
    settle(f.SetSheetRow('Sheet1', 'A1', ['ok', 2]))
    settle(f.SetCellValue('Sheet1', 'A3', 'third'))
    const plain = saveWorkbook(f)
    const parts = unzipSync(plain)
    const [sheet, workbookXml, rels, strings] = [
      'xl/worksheets/sheet1.xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
    ]
    const comment = (part: string, rewrite: (xml: string) => string) => strToU8(rewrite(strFromU8(parts[part])))
    const commented = zipSync({
      ...parts,
      [sheet]: comment(sheet, (xml) =>
        xml
          .replace('<sheetData>', '<sheetData><!-- <row r="1048576"><c r="XFD1048576"><v>1</v></c></row> -->')
          .replace(
            '<c r="A1"',
            `<!-- <c r="A1" s="${large}"><f>1+1</f></c><c r="B1" t="inlineStr"><is><t>${'x'.repeat(2_000)}</t></is></c> --><c r="A1"`,
          )
          .replace(
            '</sheetData>',
            `</sheetData><!-- <mergeCells>${'<mergeCell ref="A1:B2"/>'.repeat(10_001)}</mergeCells><conditionalFormatting/><x14:sparklineGroup/> -->`,
          ),
      ),
      [strings]: comment(strings, (xml) =>
        xml.replace('</sst>', `<!-- <si><t>${'y'.repeat(2_000)}</t></si> --></sst>`),
      ),
      [workbookXml]: comment(workbookXml, (xml) =>
        xml.replace('<sheets>', '<sheets><!-- <sheet name="Fake" sheetId="9" r:id="rId1"/> -->'),
      ),
      [rels]: comment(rels, (xml) =>
        xml.replace(
          '</Relationships>',
          '<!-- <Relationship Id="rId1" Target="worksheets/sheet9.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/> --></Relationships>',
        ),
      ),
    })
    const read = (bytes: Uint8Array) => {
      const workbook = openPreviewWorkbook(excelize, bytes)
      return { overview: workbook.overview, layout: workbook.sheet(0), rows: workbook.rows(0, 0, 5) }
    }
    const distant = patched(f, sheet, (xml) =>
      xml.replace('</sheetData>', '<row r="1048576"><c r="XFD1048576"><v>1</v></c></row></sheetData>'),
    )

    expect(read(commented)).toEqual(read(plain))
    // The same cell, real, still makes the sheet too large.
    expect(openPreviewWorkbook(excelize, distant).overview.sheets[0].tooLarge).toBe(true)
  })

  it('draws the styles a whole row or column carries on cells past the last one written', () => {
    const f = excelize.NewFile()
    const fill = (color: string) => settle(f.NewStyle({ Fill: { Type: 'pattern', Pattern: 1, Color: [color] } })).style
    const [columnStyle, rowStyle, ownStyle] = [fill('#FF0000'), fill('#00FF00'), fill('#0000FF')]
    // Before any cell is written, so Excelize keeps them on the column and the row, not on cells.
    settle(f.SetColStyle('Sheet1', 'H', columnStyle))
    settle(f.SetRowStyle('Sheet1', 6, 6, rowStyle))
    settle(f.SetCellValue('Sheet1', 'A1', 'first'))
    settle(f.SetCellStyle('Sheet1', 'A6', 'A6', ownStyle))
    const bytes = saveWorkbook(f)
    const { rows, styles } = openPreviewWorkbook(excelize, bytes).rows(0, 0, 8)
    const styleAt = (row: number, col: number) =>
      rows.find((read) => read.row === row)?.cells.find((cell) => cell.col === col)?.style
    const capped = openPreviewWorkbook(excelize, bytes, { ...xlsxPreviewLimits, columns: 5 }).rows(0, 0, 8)

    expect(styleAt(2, 7)).toBe(columnStyle)
    // Below the last row written, too.
    expect(styleAt(7, 7)).toBe(columnStyle)
    expect(styleAt(5, 3)).toBe(rowStyle)
    expect(styleAt(5, 0)).toBe(ownStyle)
    const ids = styles.map(([id]) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([columnStyle, rowStyle, ownStyle]))
    expect(capped.rows.flatMap(({ cells }) => cells).every(({ col }) => col < 5)).toBe(true)
  })

  it('hides a row the file hides below its last cell, while the rows the grid adds stay shown', () => {
    const layout = openPreviewWorkbook(
      excelize,
      withSheetData('<row r="1"><c r="A1"><v>1</v></c></row><row r="5" hidden="1"/>'),
    ).sheet(0)

    expect(layout.rows).not.toContain(4)
    expect(layout.rows).toEqual(expect.arrayContaining([1, 2, 3, 5, 29]))
  })
})
