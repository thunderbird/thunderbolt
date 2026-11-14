/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { type Excelize, type ExcelizeEngine, type ExcelizeFile, loadExcelize } from './excelize-engine'
import {
  createPreviewClient,
  type PreviewClient,
  type PreviewWorker,
  type PreviewWorkerMessage,
} from './xlsx-preview-client'
import { answerRequest, createPreviewReader, settle } from './xlsx-preview-reader'

/** Test only: Excelize from `node_modules`, the file the preview Worker fetches in the app, and its memory. */
export const loadTestEngine = async (): Promise<ExcelizeEngine> => {
  const wasm = await Bun.file(Bun.resolveSync('excelize-wasm/excelize.wasm.gz', import.meta.dir)).arrayBuffer()
  return loadExcelize(new Uint8Array(wasm))
}

/**
 * Test only: a preview client whose Worker is a stand-in that runs the real reader in process, so the client's
 * messages are exercised too. It posts `ready` at once, since Excelize is already loaded. `onClose` hears each
 * `close`.
 */
export const inProcessPreviewClient =
  (engine: ExcelizeEngine, onClose: () => void = () => {}) =>
  (): PreviewClient => {
    const reader = createPreviewReader(engine)
    const post = (data: PreviewWorkerMessage) =>
      queueMicrotask(() => worker.onmessage?.(new MessageEvent('message', { data })))
    const worker: PreviewWorker = {
      onmessage: null,
      onerror: null,
      postMessage: (request) => post(answerRequest(reader, request)),
      terminate: onClose,
    }
    post('ready')
    return createPreviewClient(() => worker)
  }

/** A 1×1 PNG. */
export const tinyPng = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

/** Test only: a workbook's bytes. Excelize types its buffer as any `BlobPart`; it is a Uint8Array. */
export const saveWorkbook = (file: ExcelizeFile): Uint8Array<ArrayBuffer> => {
  const { buffer } = settle(file.WriteToBuffer())
  if (!(buffer instanceof Uint8Array)) {
    throw new Error('WriteToBuffer returned no bytes.')
  }
  return new Uint8Array(buffer)
}

/**
 * Test only: a styled two-sheet workbook as a user or the model would make it, plus a hidden sheet. Budget has a
 * merged title, number formats, a frozen header, a hidden row and column, a link, a picture, a column chart drawn
 * from its range (Excelize saves no values in a chart), a radar chart, conditional formatting and a formula saved
 * with no result.
 */
export const styledWorkbook = (excelize: Excelize) => {
  const f = excelize.NewFile()
  const sheet = 'Budget'
  settle(f.SetSheetName('Sheet1', sheet))
  const style = (definition: Parameters<typeof f.NewStyle>[0]) => settle(f.NewStyle(definition)).style
  const title = style({
    Font: { Bold: true, Size: 16, Color: '#FFFFFF' },
    Fill: { Type: 'pattern', Pattern: 1, Color: ['#1F3864'] },
    Alignment: { Horizontal: 'center' },
  })
  const money = style({ CustomNumFmt: '"$"#,##0.00', Border: [{ Type: 'bottom', Color: '#9E9E9E', Style: 1 }] })
  settle(f.SetCellValue(sheet, 'A1', 'Q1 budget'))
  settle(f.MergeCell(sheet, 'A1', 'D1'))
  settle(f.SetCellStyle(sheet, 'A1', 'D1', title))
  settle(f.SetSheetRow(sheet, 'A2', ['Item', 'Paid on', 'Amount', 'Share']))
  settle(f.SetSheetRow(sheet, 'A3', ['Rent', 46023, 1200, 0.25]))
  settle(f.SetSheetRow(sheet, 'A4', ['Food', 46030, 450.5, 0.125]))
  settle(f.SetCellStyle(sheet, 'B3', 'B4', style({ CustomNumFmt: 'd-mmm-yyyy' })))
  settle(f.SetCellStyle(sheet, 'C3', 'C4', money))
  settle(f.SetCellStyle(sheet, 'D3', 'D4', style({ CustomNumFmt: '0.0%' })))
  settle(f.SetCellFormula(sheet, 'C5', 'SUM(C3:C4)'))
  settle(f.SetCellValue(sheet, 'A6', 'Docs'))
  settle(f.SetCellHyperLink(sheet, 'A6', 'https://example.com/docs', 'External'))
  settle(f.SetCellValue(sheet, 'A7', 'Hidden row'))
  settle(f.SetRowVisible(sheet, 7, false))
  settle(f.SetCellValue(sheet, 'E3', 'Hidden column'))
  settle(f.SetColVisible(sheet, 'E', false))
  settle(f.SetColWidth(sheet, 'A', 'A', 14))
  settle(f.SetPanes(sheet, { Freeze: true, YSplit: 2, TopLeftCell: 'A3', ActivePane: 'bottomLeft' }))
  const highlight = settle(f.NewConditionalStyle({ Font: { Color: '#9C0006' } })).style
  settle(f.SetConditionalFormat(sheet, 'C3:C4', [{ Type: 'cell', Criteria: '>', Format: highlight, Value: '1000' }]))
  settle(
    f.AddPictureFromBytes(sheet, 'A10', {
      Extension: '.png',
      File: tinyPng,
      Format: { AltText: 'Logo' },
      InsertType: excelize.PictureInsertTypePlaceOverCells,
    }),
  )
  const series = [{ Name: `${sheet}!$C$2`, Categories: `${sheet}!$A$3:$A$4`, Values: `${sheet}!$C$3:$C$4` }]
  settle(f.AddChart(sheet, 'G2', { Type: excelize.Col, Series: series, Title: { Paragraph: [{ Text: 'Spend' }] } }))
  settle(f.AddChart(sheet, 'G20', { Type: excelize.Radar, Series: series, Title: { Paragraph: [{ Text: 'Mix' }] } }))
  settle(f.NewSheet('Notes'))
  settle(f.SetCellValue('Notes', 'A1', 'Second sheet'))
  settle(f.NewSheet('Secret'))
  settle(f.SetCellValue('Secret', 'A1', 'Never shown'))
  settle(f.SetSheetVisible('Secret', false))
  return saveWorkbook(f)
}

/** The longest text a cell holds. */
export const longestCellText = 'L'.repeat(32_767)

/** Where a hostile workbook's linked picture points. Nothing may ever request it. */
export const hostileProbeUrl = 'https://xlsx-probe.invalid/linked-image.png'

/**
 * Test only: a hostile workbook. Markup in cell text and the sheet name, a `javascript:` link, a 32,767-character
 * cell, an embedded SVG with a script, and a picture linked to a URL outside the file.
 */
export const hostileWorkbook = (excelize: Excelize) => {
  const f = excelize.NewFile()
  const sheet = '<img src=x onerror=alert(1)>'
  settle(f.SetSheetName('Sheet1', sheet))
  settle(f.SetCellValue(sheet, 'A1', '<img src=x onerror="window.__xlsxProbe=1">'))
  settle(f.SetCellValue(sheet, 'B1', '<script>window.__xlsxProbe=1</script>'))
  settle(f.SetCellValue(sheet, 'A2', 'click me'))
  settle(f.SetCellHyperLink(sheet, 'A2', 'javascript:window.__xlsxProbe=1', 'External'))
  settle(f.SetCellValue(sheet, 'A3', longestCellText))
  settle(
    f.AddPictureFromBytes(sheet, 'A6', {
      Extension: '.png',
      File: tinyPng,
      Format: {},
      InsertType: excelize.PictureInsertTypePlaceOverCells,
    }),
  )
  const parts = unzipSync(saveWorkbook(f))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__xlsxProbe=1</script></svg>`
  parts['xl/media/hostile.svg'] = strToU8(svg)
  const rels = 'xl/drawings/_rels/drawing1.xml.rels'
  parts[rels] = strToU8(
    strFromU8(parts[rels]).replace(
      '</Relationships>',
      `<Relationship Id="rIdSvg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/hostile.svg"/>` +
        `<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${hostileProbeUrl}" TargetMode="External"/></Relationships>`,
    ),
  )
  const picture = (col: number, blip: string) =>
    `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${col + 2}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${col + 10}" name="p${col}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ${blip}/></xdr:blipFill>` +
    `<xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`
  const drawing = 'xl/drawings/drawing1.xml'
  parts[drawing] = strToU8(
    strFromU8(parts[drawing]).replace(
      '</xdr:wsDr>',
      `${picture(0, 'r:embed="rIdSvg"')}${picture(3, 'r:link="rIdLink"')}</xdr:wsDr>`,
    ),
  )
  return zipSync(parts)
}
