/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { DOMParser, onWarningStopParsing } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
// Not the browser build: `xlsx-to-text.test.ts` mocks that module for the whole run.
import readXlsxFile from 'read-excel-file/node'
import { xlsmMime, xlsxMime } from '@/files/transformers'
import type { StoredFile } from '@/lib/file-blob-storage'
import { type SandboxLimits, sandboxLimits } from './constants'
import { createOfficeScriptTool, type OfficeScriptOutput } from './office-script-tool'
import { runSandboxedScript, type SandboxJob, type SandboxResult, type SandboxRuntime } from './sandbox'
import { loadTestSandboxRuntime } from './sandbox-test-runtime'
import { loadSpreadsheetEngines } from './spreadsheet-engines'

type Runner = (job: SandboxJob, limits: SandboxLimits) => Promise<SandboxResult>

const runtime = await loadTestSandboxRuntime()

let workbookLoads = 0
const countingRuntime: SandboxRuntime = {
  ...runtime,
  loadWorkbooks: async () => {
    workbookLoads += 1
    return runtime.loadWorkbooks()
  },
}

const inProcess: Runner = (job, limits) => runSandboxedScript(countingRuntime, job, limits)

// The same runs in a Bun Worker without `Symbol.dispose`, standing in for system WebKit, one at a time.
const worker = new Worker(new URL('./no-symbol-dispose.test-worker.ts', import.meta.url))
const workerReady = new Promise<void>((resolve) => {
  worker.onmessage = () => resolve()
})
let queue: Promise<unknown> = workerReady
const withoutSymbolDispose: Runner = (job, limits) => {
  const run = queue.then(
    () =>
      new Promise<SandboxResult>((resolve) => {
        worker.onmessage = ({ data }: MessageEvent<SandboxResult>) => resolve(data)
        worker.postMessage({ job, limits })
      }),
  )
  queue = run
  return run
}

afterAll(() => worker.terminate())

const attachmentStore = new Map<string, StoredFile>()

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`./test-fixtures/${name}`, import.meta.url)).arrayBuffer())

const storeAttachment = (filename: string, bytes: Uint8Array<ArrayBuffer>): StoredFile => {
  const file = {
    id: crypto.randomUUID(),
    filename,
    mimeType: filename.endsWith('.xlsm') ? xlsmMime : xlsxMime,
    size: bytes.byteLength,
    createdAt: Date.now(),
    blob: new Blob([bytes]),
  }
  attachmentStore.set(file.id, file)
  return file
}

const packageFile = async (specifier: string) =>
  new Uint8Array(await Bun.file(Bun.resolveSync(specifier, import.meta.dir)).arrayBuffer())

const partsOf = async (file: StoredFile) => unzipSync(new Uint8Array(await file.blob.arrayBuffer()))

const textOf = (parts: Record<string, Uint8Array>, part: string) => strFromU8(parts[part])

const count = (xml: string, pattern: RegExp) => xml.match(pattern)?.length ?? 0

/** Every row of every sheet, as the second reader sees them. */
const rowsOf = async (file: StoredFile) => readXlsxFile(Buffer.from(await file.blob.arrayBuffer()))

const mib = 1024 * 1024

const budgetScript = `
const f = excelize.NewFile()
const money = f.NewStyle({ NumFmt: 4, Fill: { Type: 'pattern', Pattern: 1, Color: ['#DDEBF7'] } }).style
f.SetSheetRow('Sheet1', 'A1', ['Item', 'Q1', 'Q2'])
f.SetSheetRow('Sheet1', 'A2', ['Rent', 1200, 1250.5])
f.SetSheetRow('Sheet1', 'A3', ['Food', 450, 470])
f.SetCellValue('Sheet1', 'A4', 'Total')
f.SetCellFormula('Sheet1', 'B4', 'SUM(B2:B3)')
f.SetCellFormula('Sheet1', 'C4', 'SUM(C2:C3)')
f.SetCellFormula('Sheet1', 'D4', 'C4/B4')
f.SetCellFormula('Sheet1', 'E4', 'C4>B4')
f.SetCellFormula('Sheet1', 'F4', 'A4&" (both quarters)"')
f.SetCellValue('Sheet1', 'A6', '00123')
f.SetCellFormula('Sheet1', 'B6', 'A6&""')
f.SetCellStyle('Sheet1', 'B2', 'C4', money)
saveFile('budget.xlsx', f.WriteToBuffer().buffer)
`

describe.each([
  ['with Symbol.dispose', inProcess],
  ['without Symbol.dispose', withoutSymbolDispose],
] as const)('run_office_script on workbooks %s', (_, runner) => {
  const tool = (limits: Partial<SandboxLimits> = {}) =>
    createOfficeScriptTool({
      runScript: (job) => runner(job, { ...sandboxLimits, ...limits }),
      storeFiles: async (files) => files.forEach((file) => attachmentStore.set(file.id, file)),
      listThreadFiles: async () => [...attachmentStore.values()],
    })

  const run = (script: string, inputs?: string[], limits?: Partial<SandboxLimits>) =>
    tool(limits).execute({ script, inputs }) as Promise<OfficeScriptOutput>

  const runOk = async (script: string, inputs?: string[]) => {
    const output = await run(script, inputs)
    if (!output.ok) {
      throw new Error(output.error)
    }
    return { output, file: attachmentStore.get(output.files[0].id)! }
  }

  const errorOf = async (script: string, inputs?: string[], limits?: Partial<SandboxLimits>) => {
    const output = await run(script, inputs, limits)
    expect(output.ok).toBe(false)
    return output.ok ? '' : output.error
  }

  it('creates a workbook whose formula cells read back as numbers, text and booleans', async () => {
    const { output, file } = await runOk(budgetScript)
    expect(output.files[0]).toMatchObject({ filename: 'budget.xlsx', mimeType: xlsxMime, edited: false })
    expect(output.formulaErrors).toBeUndefined()
    const [{ data }] = await rowsOf(file)
    const [label, q1, q2, ratio, ...rest] = data[3]
    expect([label, q1, q2, ...rest]).toEqual(['Total', 1650, 1720.5, true, 'Total (both quarters)'])
    // Cached to 15 significant digits, as many as Excel shows.
    expect(ratio).toBeCloseTo(1720.5 / 1650, 13)
    // Text that looks like a number stays text, in the cell and in a formula that reads it.
    expect(data[5].slice(0, 2)).toEqual(['00123', '00123'])
  })

  it('names Microsoft Excel as the application of a new workbook', async () => {
    const { file } = await runOk(budgetScript)
    expect(textOf(await partsOf(file), 'docProps/app.xml')).toContain('<Application>Microsoft Excel</Application>')
  })

  it('keeps the fills and number formats a script sets', async () => {
    const { file } = await runOk(budgetScript)
    const styles = textOf(await partsOf(file), 'xl/styles.xml')
    expect(styles).toContain('rgb="FFDDEBF7"')
    expect(styles).toMatch(/<xf [^>]*numFmtId="4"/)
  })

  it('computes shared formulas cell by cell', async () => {
    const { file } = await runOk(`
const f = excelize.NewFile()
f.SetSheetCol('Sheet1', 'A1', [1, 2, 3])
f.SetCellFormula('Sheet1', 'B1', 'A1*10', { Ref: 'B1:B3', Type: 'shared' })
saveFile('shared.xlsx', f.WriteToBuffer().buffer)
`)
    const [{ data }] = await rowsOf(file)
    expect(data.map((row) => row[1])).toEqual([10, 20, 30])
  })

  it('lists a formula it cannot compute with its cell, and saves the rest', async () => {
    const output = await run(`
const f = excelize.NewFile()
f.SetSheetCol('Sheet1', 'A1', [4, 6])
f.SetCellFormula('Sheet1', 'B1', 'AGGREGATE(9,6,A1:A2)')
f.SetCellFormula('Sheet1', 'B2', 'SUM(A1:A2)')
saveFile('partly.xlsx', f.WriteToBuffer().buffer)
`)
    expect(output.ok).toBe(true)
    expect(output.ok && output.formulaErrors).toEqual([
      { file: 'partly.xlsx', sheet: 'Sheet1', cell: 'B1', formula: 'AGGREGATE(9,6,A1:A2)', error: '#NAME?' },
    ])
    const [{ data }] = await rowsOf(attachmentStore.get(output.ok ? output.files[0].id : '')!)
    expect(data[1][1]).toBe(10)
  })

  it('lists formula errors once per saved file, under its name', async () => {
    const output = await run(`
const broken = (name) => {
  const f = excelize.NewFile()
  f.SetCellFormula('Sheet1', 'A1', 'AGGREGATE(9,6,B1:B2)')
  f.WriteToBuffer()
  saveFile(name, f.WriteToBuffer().buffer)
}
broken('first.xlsx')
broken('second.xlsx')
const unsaved = excelize.NewFile()
unsaved.SetCellFormula('Sheet1', 'A1', 'AGGREGATE(9,6,B1:B2)')
unsaved.WriteToBuffer()
`)
    expect(output.ok && output.formulaErrors?.map(({ file, cell }) => `${file}!${cell}`)).toEqual([
      'first.xlsx!A1',
      'second.xlsx!A1',
    ])
  })

  it('computes formulas far apart on a sheet without styling the cells between them', async () => {
    const { file } = await runOk(`
const f = excelize.NewFile()
f.SetCellFormula('Sheet1', 'A1', '1+1')
f.SetCellFormula('Sheet1', 'Z200000', 'A1*2')
saveFile('far.xlsx', f.WriteToBuffer().buffer)
`)
    const sheet = textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="A1"><f>1+1</f><v>2</v></c>')
    expect(sheet).toContain('<c r="Z200000"><f>A1*2</f><v>4</v></c>')
  })

  it('stores a formula written with a leading = without it, and computes it', async () => {
    const { file } = await runOk(`
const f = excelize.NewFile()
f.SetCellFormula('Sheet1', 'A1', '=SUM(1,2)')
saveFile('equals.xlsx', f.WriteToBuffer().buffer)
`)
    expect(textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')).toContain('<c r="A1"><f>SUM(1,2)</f><v>3</v></c>')
  })

  it('escapes control characters in a text result, so the sheet stays valid XML', async () => {
    const { file } = await runOk(`
const f = excelize.NewFile()
f.SetCellFormula('Sheet1', 'A1', 'CHAR(7)&"_x0041_"')
saveFile('control.xlsx', f.WriteToBuffer().buffer)
`)
    const sheet = textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<v>_x0007__x005F_x0041_</v>')
    expect(() => new DOMParser({ onError: onWarningStopParsing }).parseFromString(sheet, 'text/xml')).not.toThrow()
  })

  it('escapes the characters XML forbids above U+FFFD', async () => {
    const { file } = await runOk(`
const f = excelize.NewFile()
f.SetCellFormula('Sheet1', 'A1', 'UNICHAR(65534)&UNICHAR(65535)')
saveFile('noncharacters.xlsx', f.WriteToBuffer().buffer)
`)
    expect(textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')).toContain('<v>_xFFFE__xFFFF_</v>')
  })

  it('leaves hidden rows out of SUBTOTAL, as Excel does', async () => {
    const { file } = await runOk(`
const f = excelize.NewFile()
f.SetSheetCol('Sheet1', 'A1', [10, 20])
f.SetRowVisible('Sheet1', 2, false)
f.SetCellFormula('Sheet1', 'B1', 'SUBTOTAL(109,A1:A2)')
saveFile('hidden.xlsx', f.WriteToBuffer().buffer)
`)
    expect(textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')).toContain('<f>SUBTOTAL(109,A1:A2)</f><v>10</v>')
  })

  it('computes nothing in a workbook that counts dates from 1904, and says so', async () => {
    const output = await run(`
const f = excelize.NewFile()
f.SetWorkbookProps({ Date1904: true })
f.SetCellFormula('Sheet1', 'A1', 'DATE(2020,1,1)')
saveFile('mac.xlsx', f.WriteToBuffer().buffer)
`)
    expect(output.ok && output.formulaErrors).toEqual([
      {
        file: 'mac.xlsx',
        sheet: 'Sheet1',
        cell: 'A1',
        formula: 'DATE(2020,1,1)',
        error: 'the workbook counts dates from 1904, so no formula is computed',
      },
    ])
  })

  it('lists the formula errors of an earlier buffer the script saves', async () => {
    const output = await run(`
const f = excelize.NewFile()
f.SetCellFormula('Sheet1', 'A1', 'AGGREGATE(9,6,B1:B2)')
const first = f.WriteToBuffer().buffer
f.SetCellFormula('Sheet1', 'A1', 'SUM(B1:B2)')
f.WriteToBuffer()
saveFile('first.xlsx', first)
`)
    expect(output.ok && output.formulaErrors?.map(({ file, cell }) => `${file}!${cell}`)).toEqual(['first.xlsx!A1'])
  })

  it('still parses the parts Excelize copied from the workbook it opened', async () => {
    const parts = unzipSync(await fixture('WithChart.xlsx'))
    parts['xl/charts/chart1.xml'] = strToU8('<c:chartSpace><broken></c:chartSpace>')
    storeAttachment('broken-chart.xlsx', zipSync(parts))
    const error = await errorOf(
      `saveFile('broken-chart.xlsx', excelize.OpenReader(readFile('broken-chart.xlsx')).WriteToBuffer().buffer)`,
      ['broken-chart.xlsx'],
    )
    expect(error).toContain('its part xl/charts/chart1.xml is not valid XML')
  })

  it('makes the script pay for building the arguments it passes', async () => {
    const error = await errorOf(`excelize.ColumnNumberToName(new Array(2 ** 31))`)
    expect(error).toContain('MiB of memory and was stopped')
  })

  it('releases each result the script drops, so reading a cell many times stays under the memory limit', async () => {
    const { output } = await runOk(`
const f = excelize.NewFile()
f.SetCellValue('Sheet1', 'A1', 'x'.repeat(30000))
for (let i = 0; i < 2500; i++) f.GetCellValue('Sheet1', 'A1')
saveFile('read.xlsx', f.WriteToBuffer().buffer)
`)
    expect(output.ok).toBe(true)
  })

  it('lists a data-table formula, which has no text, and keeps its cached result', async () => {
    const output = await run(`
const made = excelize.NewFile()
made.SetSheetCol('Sheet1', 'A1', [1, 2])
const parts = fflate.unzipSync(made.WriteToBuffer().buffer)
const sheet = fflate.strFromU8(parts['xl/worksheets/sheet1.xml'])
parts['xl/worksheets/sheet1.xml'] = fflate.strToU8(sheet.replace('</row>', '<c r="B1"><f t="dataTable" ref="B1:B2" dt2D="0" dtr="0" r1="A1"/><v>3</v></c></row>'))
const f = excelize.OpenReader(fflate.zipSync(parts))
saveFile('table.xlsx', f.WriteToBuffer().buffer)
`)
    expect(output.ok && output.formulaErrors).toEqual([
      {
        file: 'table.xlsx',
        sheet: 'Sheet1',
        cell: 'B1',
        formula: '',
        error:
          'an array or data-table formula, which is not computed; formulas that read its cells use the values saved in them',
      },
    ])
    const sheet = textOf(
      await partsOf(attachmentStore.get(output.ok ? output.files[0].id : '')!),
      'xl/worksheets/sheet1.xml',
    )
    expect(sheet).toContain('<v>3</v>')
  })

  it('edits a workbook opened with its password, and saves it without one', async () => {
    const engines = await loadSpreadsheetEngines(
      await packageFile('excelize-wasm/excelize.wasm.gz'),
      await packageFile('@ironcalc/wasm/wasm_bg.wasm'),
    )
    const locked = engines.excelize.NewFile()
    locked.SetCellValue('Sheet1', 'A1', 5)
    const { buffer } = locked.WriteToBuffer({ Password: 'pw' })
    if (!(buffer instanceof Uint8Array)) {
      throw new Error('WriteToBuffer returned no bytes')
    }
    storeAttachment('locked.xlsx', new Uint8Array(buffer))
    const { file } = await runOk(
      `
const f = excelize.OpenReader(readFile('locked.xlsx'), { Password: 'pw' })
f.SetCellFormula('Sheet1', 'B1', 'A1*2')
saveFile('locked.xlsx', f.WriteToBuffer().buffer)
`,
      ['locked.xlsx'],
    )
    expect(textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')).toContain('<f>A1*2</f><v>10</v>')
  })

  it('refuses options it cannot use, and a password on save', async () => {
    expect(await errorOf(`excelize.NewFile({ Password: 1234 })`)).toContain('NewFile got options it cannot use')
    expect(await errorOf(`excelize.NewFile().WriteToBuffer({ Password: 'secret' })`)).toContain(
      'WriteToBuffer takes no options here, so a workbook cannot be saved with a password.',
    )
  })

  it('saves a workbook with macros only as .xlsm', async () => {
    storeAttachment('SimpleMacro.xlsm', await fixture('SimpleMacro.xlsm'))
    const addMacros = (name: string) => `
const vba = fflate.unzipSync(readFile('SimpleMacro.xlsm'))['xl/vbaProject.bin']
const f = excelize.NewFile()
f.AddVBAProject(vba)
saveFile(${JSON.stringify(name)}, f.WriteToBuffer().buffer)
`
    const { file } = await runOk(addMacros('macros.xlsm'), ['SimpleMacro.xlsm'])
    expect(textOf(await partsOf(file), '[Content_Types].xml')).toContain('macroEnabled.main+xml')
    expect(await errorOf(addMacros('macros.xlsx'), ['SimpleMacro.xlsm'])).toBe(
      '"macros.xlsx" holds macros, and Excel opens a workbook with macros only as .xlsm. Save it as .xlsm, then call the tool again.',
    )
    expect(
      await errorOf(`saveFile('plain.xlsm', excelize.NewFile().WriteToBuffer().buffer)`, ['SimpleMacro.xlsm']),
    ).toBe(
      '"plain.xlsm" has no macros, and Excel opens an .xlsm file only when it has them. Save it as .xlsx, then call the tool again.',
    )
  })

  it('edits an attached workbook, keeping its styles, charts, conditional formats and app name', async () => {
    const original = await fixture('WithChart.xlsx')
    storeAttachment('chart.xlsx', original)
    const { output, file } = await runOk(
      `
const f = excelize.OpenReader(readFile('chart.xlsx'))
const [sheet] = f.GetSheetList().list.filter((name) => f.GetSheetDimension(name).dimension !== 'A1')
f.SetCellValue(sheet, 'H1', 'Checked')
f.SetCellFormula(sheet, 'H2', 'ROWS(A1:A10)')
saveFile('chart.xlsx', f.WriteToBuffer().buffer)
`,
      ['chart.xlsx'],
    )
    expect(output.files[0].edited).toBe(true)
    const before = unzipSync(original)
    const after = await partsOf(file)
    expect(after['xl/charts/chart1.xml']).toEqual(before['xl/charts/chart1.xml'])
    expect(after['xl/drawings/drawing1.xml']).toEqual(before['xl/drawings/drawing1.xml'])
    expect(after['docProps/app.xml']).toEqual(before['docProps/app.xml'])
    const cellFormats = (parts: Record<string, Uint8Array>) =>
      count(textOf(parts, 'xl/styles.xml').match(/<cellXfs[\s\S]*?<\/cellXfs>/)?.[0] ?? '', /<xf\b/g)
    expect(cellFormats(after)).toBe(cellFormats(before))
  })

  it('keeps the conditional formatting of an attached workbook', async () => {
    const original = await fixture('WithConditionalFormatting.xlsx')
    storeAttachment('rules.xlsx', original)
    const { file } = await runOk(
      `
const f = excelize.OpenReader(readFile('rules.xlsx'))
f.SetCellValue(f.GetSheetList().list[0], 'Z1', 1)
saveFile('rules.xlsx', f.WriteToBuffer().buffer)
`,
      ['rules.xlsx'],
    )
    const rules = (parts: Record<string, Uint8Array>) => count(textOf(parts, 'xl/worksheets/sheet1.xml'), /<cfRule\b/g)
    expect(rules(await partsOf(file))).toBe(rules(unzipSync(original)))
    expect(rules(unzipSync(original))).toBeGreaterThan(0)
  })

  it('keeps the pivot tables, images and macro of an attached workbook', async () => {
    const cases = [
      { name: 'ExcelPivotTableSample.xlsx', parts: /^xl\/pivot(Tables|Cache)\// },
      { name: 'WithDrawing.xlsx', parts: /^xl\/(media|drawings)\// },
      { name: 'SimpleMacro.xlsm', parts: /^xl\/vbaProject\.bin$/ },
    ]
    for (const { name, parts } of cases) {
      const original = await fixture(name)
      storeAttachment(name, original)
      const { output, file } = await runOk(
        `
const f = excelize.OpenReader(readFile(${JSON.stringify(name)}))
f.SetCellValue(f.GetSheetList().list[0], 'Z1', 'reviewed')
saveFile(${JSON.stringify(name)}, f.WriteToBuffer().buffer)
`,
        [name],
      )
      expect(output.files[0].mimeType).toBe(name.endsWith('.xlsm') ? xlsmMime : xlsxMime)
      const before = unzipSync(original)
      const after = await partsOf(file)
      const kept = Object.keys(before).filter((part) => parts.test(part))
      expect(kept.length).toBeGreaterThan(0)
      for (const part of kept) {
        expect(after[part]).toEqual(before[part])
      }
    }
  })

  it('stores fresh results for the formulas of an edited workbook', async () => {
    storeAttachment('budget.xlsx', new Uint8Array(await (await runOk(budgetScript)).file.blob.arrayBuffer()))
    const { file } = await runOk(
      `
const f = excelize.OpenReader(readFile('budget.xlsx'))
f.SetCellValue('Sheet1', 'B2', 2000)
saveFile('budget.xlsx', f.WriteToBuffer().buffer)
`,
      ['budget.xlsx'],
    )
    const [{ data }] = await rowsOf(file)
    expect(data[3][1]).toBe(2450)
  })

  it('refuses to open a workbook over 2 MiB', async () => {
    storeAttachment('big.xlsx', new Uint8Array(2 * mib + 1))
    const error = await errorOf(`excelize.OpenReader(readFile('big.xlsx'))`, ['big.xlsx'])
    expect(error).toContain(
      'This workbook is larger than the 2 MiB excelize can open here. Stop and tell the user it is too large to edit here',
    )
  })

  it('refuses a workbook that unzips past the limit', async () => {
    const bomb = zipSync({
      ...unzipSync(await fixture('WithChart.xlsx')),
      'xl/padding.xml': strToU8(' '.repeat(2 * mib)),
    })
    storeAttachment('bomb.xlsx', bomb)
    const error = await errorOf(`excelize.OpenReader(readFile('bomb.xlsx'))`, ['bomb.xlsx'], {
      workbookUnzipBytes: mib,
    })
    expect(error).toContain('This workbook unzips to more than 1 MiB, the most excelize can open here.')
  })

  it('stops a run once Excelize passes its memory limit', async () => {
    const error = await errorOf(
      `
const f = excelize.NewFile()
for (let row = 1; row < 1e6; row++) f.SetSheetRow('Sheet1', 'A' + row, Array.from({ length: 20 }, (_, i) => 'text ' + row + i))
`,
      [],
      { workbookMemoryBytes: 32 * mib },
    )
    expect(error).toBe(
      'Excelize used more than 32 MiB of memory and the run was stopped. Work on fewer cells in one run, or on a smaller workbook.',
    )
  })

  it('throws the reason of a workbook call that fails', async () => {
    const error = await errorOf(`excelize.NewFile().SetCellValue('Nope', 'A1', 1)`)
    expect(error).toContain('SetCellValue: sheet Nope does not exist')
  })

  it('reaches only the workbook calls', async () => {
    const { output } = await runOk(`
const f = excelize.NewFile()
const tries = [
  () => __workbook(1, 'constructor', '[]'),
  () => __workbook(0, 'init', '["excelize.wasm.gz"]'),
  () => __workbook(0, 'ColumnNumberToName', '{'),
  // JSON drops a function, so it arrives as null.
  () => f.SetCellValue('Sheet1', 'A1', () => 1),
]
for (const attempt of tries) {
  try { attempt(); console.log('reached') } catch (error) { console.log(error.message) }
}
console.log(typeof Go, typeof excelize.init, typeof excelize.NewFile, typeof excelize.CellNameToCoordinates)
saveFile('empty.xlsx', f.WriteToBuffer().buffer)
`)
    expect(output.logs).toBe(
      [
        'A workbook has no method constructor.',
        'excelize.init is not a function.',
        'Workbook calls take strings, numbers, booleans, arrays, objects and Uint8Array bytes.',
        'SetCellValue: invalid argument data type',
        'undefined undefined function function',
        '',
      ].join('\n'),
    )
  })
})

describe('run_office_script without workbooks', () => {
  it('loads Excelize only for a script that uses it', async () => {
    const before = workbookLoads
    await inProcess({ script: `saveFile('a.docx', fflate.zipSync({}))`, inputs: [] }, sandboxLimits)
    expect(workbookLoads).toBe(before)
    await inProcess({ script: `excelize.NewFile()`, inputs: [] }, sandboxLimits)
    expect(workbookLoads).toBe(before + 1)
  })
})
