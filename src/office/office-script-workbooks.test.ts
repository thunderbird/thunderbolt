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
import { officeSkillNames, type SandboxLimits, sandboxLimits } from './constants'
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

/** The tool over one runner, its files kept in the attachment store, with these limits, offering these skills. */
const toolWith = (runner: Runner, limits: Partial<SandboxLimits> = {}, skills: string[] = []) =>
  createOfficeScriptTool({
    runScript: (job) => runner(job, { ...sandboxLimits, ...limits }),
    storeFiles: async (files) => files.forEach((file) => attachmentStore.set(file.id, file)),
    listThreadFiles: async () => [...attachmentStore.values()],
    skills,
  })

/** Run a script that must succeed, and the first file it saved. */
const runOkWith = async (runner: Runner, script: string, inputs?: string[]) => {
  const output = (await toolWith(runner).execute({ script, inputs })) as OfficeScriptOutput
  if (!output.ok) {
    throw new Error(output.error)
  }
  return { output, file: attachmentStore.get(output.files[0].id)! }
}

describe.each([
  ['with Symbol.dispose', inProcess],
  ['without Symbol.dispose', withoutSymbolDispose],
] as const)('run_office_script on workbooks %s', (_, runner) => {
  const run = (script: string, inputs?: string[], limits?: Partial<SandboxLimits>) =>
    toolWith(runner, limits).execute({ script, inputs }) as Promise<OfficeScriptOutput>

  const runOk = (script: string, inputs?: string[]) => runOkWith(runner, script, inputs)

  /** The error of one call to `tool`, which must fail. */
  const failureOn = async (tool: ReturnType<typeof toolWith>, script: string, inputs?: string[]) => {
    const output = (await tool.execute({ script, inputs })) as OfficeScriptOutput
    expect(output.ok).toBe(false)
    return output.ok ? '' : output.error
  }

  const errorOf = (script: string, inputs?: string[], limits?: Partial<SandboxLimits>) =>
    failureOn(toolWith(runner, limits), script, inputs)

  // What `failureHint` in office-script-tool.ts adds to the first failure of a send that offers the Excel skill.
  const loadHint = `load the Office skill for this format unless its instructions are already in context: ${officeSkillNames.xlsx}.`
  const recoverable = `const f = excelize.NewFile()
f.SetConditionalFormat("Sheet1", "A1:A2", [{ Type: "expression", Criteria: "$A1>1", Format: 0 }])`

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
      { file: 'partly.xlsx', sheet: 'Sheet1', cell: 'B1', formula: '_xlfn.AGGREGATE(9,6,A1:A2)', error: '#NAME?' },
    ])
    const [{ data }] = await rowsOf(attachmentStore.get(output.ok ? output.files[0].id : '')!)
    expect(data[1][1]).toBe(10)
  })

  it('gives the script the formula errors before it saves anything', async () => {
    const output = await run(`
const f = excelize.NewFile()
f.SetCellFormula('Sheet1', 'A1', 'AGGREGATE(9,6,B1:B2)')
const { formulaErrors } = f.WriteToBuffer()
console.log(formulaErrors.map(({ cell, error }) => cell + ' ' + error).join(', '))
`)
    expect(output).toMatchObject({ ok: true, files: [], logs: 'A1 #NAME?\n' })
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

  it('stores the functions Excel added after 2007 with the prefix Excel needs, and still computes them', async () => {
    const { file } = await runOk(`
const f = excelize.NewFile()
f.SetCellFormula('Sheet1', 'A1', 'concat("a","AGGREGATE(1)")&IFS(TRUE,"b")')
f.SetCellFormula('Sheet1', 'A2', '_xlfn.CONCAT("c",SUM(1,2))')
f.SetCellFormula('Sheet1', 'A3', 'ROWS(FILTER(B1:B2,B1:B2=0))')
saveFile('future.xlsx', f.WriteToBuffer().buffer)
`)
    const sheet = textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain(
      '<f>_xlfn.CONCAT(&#34;a&#34;,&#34;AGGREGATE(1)&#34;)&amp;_xlfn.IFS(TRUE,&#34;b&#34;)</f><v>aAGGREGATE(1)b</v>',
    )
    expect(sheet).toContain('<f>_xlfn.CONCAT(&#34;c&#34;,SUM(1,2))</f><v>c3</v>')
    expect(sheet).toContain('<f>ROWS(_xlfn._xlws.FILTER(B1:B2,B1:B2=0))</f>')
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

  /** Save an attached workbook after editing only its control sheet, so Excelize copies the formula sheet verbatim. */
  const saveWithUntouchedRows = async (rows: string) => {
    const { file: seed } = await runOk(`
const f = excelize.NewFile()
f.NewSheet('Control')
saveFile('seed.xlsx', f.WriteToBuffer().buffer)
`)
    const parts = await partsOf(seed)
    const sheet = 'xl/worksheets/sheet1.xml'
    parts[sheet] = strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:review="urn:review"
      mc:Ignorable="review"><sheetData>${rows}</sheetData></worksheet>`)
    storeAttachment('annotated.xlsx', zipSync(parts))
    const { file, output } = await runOk(
      `
const f = excelize.OpenReader(readFile('annotated.xlsx'))
f.SetCellValue('Control', 'A1', 'edited')
saveFile('annotated.xlsx', f.WriteToBuffer().buffer)
`,
      ['annotated.xlsx'],
    )
    expect(output.formulaErrors).toBeUndefined()
    return textOf(await partsOf(file), sheet)
  }

  it.each(['>', '&gt;'])('excludes a hidden row after a quoted %s on an untouched sheet', async (gt) => {
    const sheet =
      await saveWithUntouchedRows(`<row r="1" review:note="Q1${gt}Q2" hidden="1"><c r="A1"><v>21</v></c></row>
      <row r="2"><c r="A2"><v>4</v></c></row><row r="3"><c r="B3"><f>SUBTOTAL(109,A1:A2)</f></c></row>`)
    expect(sheet).toContain('<c r="B3"><f>SUBTOTAL(109,A1:A2)</f><v>4</v></c>')
  })

  it('preserves a quoted > on an untouched formula cell when writing its cache', async () => {
    const cellTag = '<c r="B1" xmlns:q="urn:q" q:note="a>b">'
    const sheet = await saveWithUntouchedRows(`<row r="1"><c r="A1"><v>21</v></c>${cellTag}<f>A1*2</f></c></row>`)
    expect(sheet).toContain(`${cellTag}<f>A1*2</f><v>42</v></c>`)
  })

  it('computes a formula on a sheet opened with a literal > in its name', async () => {
    const { file } = await runOk(`
const made = excelize.NewFile()
made.NewSheet('Q1>Q2')
const parts = fflate.unzipSync(made.WriteToBuffer().buffer)
const workbook = 'xl/workbook.xml'
parts[workbook] = fflate.strToU8(fflate.strFromU8(parts[workbook]).replace(/name="Q1[^"]*Q2"/, 'name="Q1>Q2"'))
const f = excelize.OpenReader(fflate.zipSync(parts))
f.SetCellFormula('Q1>Q2', 'A1', '6*7')
saveFile('quarters.xlsx', f.WriteToBuffer().buffer)
`)
    expect(textOf(await partsOf(file), 'xl/worksheets/sheet2.xml')).toContain('<c r="A1"><f>6*7</f><v>42</v></c>')
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
    // A smaller VM reaches its limit sooner; the charge is the same at any size.
    const error = await errorOf(`excelize.ColumnNumberToName(new Array(2 ** 31))`, undefined, { memoryBytes: 16 * mib })
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

  it('never adds macros to a workbook', async () => {
    storeAttachment('SimpleMacro.xlsm', await fixture('SimpleMacro.xlsm'))
    const addMacros = `
const vba = fflate.unzipSync(readFile('SimpleMacro.xlsm'))['xl/vbaProject.bin']
const f = excelize.NewFile()
f.AddVBAProject(vba)
saveFile('macros.xlsm', f.WriteToBuffer().buffer)
`
    expect(await errorOf(addMacros, ['SimpleMacro.xlsm'])).toContain(
      'TypeError: This tool does not add macros to a workbook.',
    )
    expect(await errorOf(`saveFile('plain.xlsm', excelize.NewFile().WriteToBuffer().buffer)`)).toBe(
      '"plain.xlsm" has no macros, and Excel opens an .xlsm file only when it has them. Save it as .xlsx, then call the tool again.',
    )
  })

  it('saves a .xlsx that holds a macro project as .xlsx, and refuses to turn it into a .xlsm', async () => {
    const parts = unzipSync(await fixture('SimpleMacro.xlsm'))
    const types = textOf(parts, '[Content_Types].xml').replace(
      'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    )
    storeAttachment('budget.xlsx', zipSync({ ...parts, '[Content_Types].xml': strToU8(types) }))
    const edit = (name: string) => `
const f = excelize.OpenReader(readFile('budget.xlsx'))
f.SetCellValue(f.GetSheetList().list[0], 'B2', 1200)
saveFile(${JSON.stringify(name)}, f.WriteToBuffer().buffer)
`
    const { output, file } = await runOk(edit('budget.xlsx'), ['budget.xlsx'])
    expect(output.files[0]).toMatchObject({ filename: 'budget.xlsx', mimeType: xlsxMime, edited: true })
    expect(textOf(await partsOf(file), '[Content_Types].xml')).not.toContain('macroEnabled')

    expect(await errorOf(edit('budget.xlsm'), ['budget.xlsx'])).toBe(
      '"budget.xlsm" has no macros, and Excel opens an .xlsm file only when it has them. Save it as .xlsx, then call the tool again.',
    )
  })

  it('refuses a .xlsm unless the run read one, even when the script marks it as having macros', async () => {
    const marked = `
const parts = fflate.unzipSync(excelize.NewFile().WriteToBuffer().buffer)
parts['xl/vbaProject.bin'] = new Uint8Array(16)
const types = fflate.strFromU8(parts['[Content_Types].xml'])
parts['[Content_Types].xml'] = fflate.strToU8(types.replace('sheet.main+xml', 'sheet.macroEnabled.main+xml'))
saveFile('tool.xlsm', fflate.zipSync(parts))
`
    expect(await errorOf(marked)).toBe(
      '"tool.xlsm" would be a workbook with macros, but this run read none. This tool keeps the macros of a workbook that has them and never adds any, so save it as .xlsx.',
    )
  })

  it('refuses macros the script added to or changed in a .xlsm it read', async () => {
    const withoutMacros = unzipSync(await fixture('SimpleMacro.xlsm'))
    delete withoutMacros['xl/vbaProject.bin']
    storeAttachment('plain.xlsm', zipSync(withoutMacros))
    storeAttachment('SimpleMacro.xlsm', await fixture('SimpleMacro.xlsm'))
    const save = (input: string, macros: string) => `
const parts = fflate.unzipSync(readFile('${input}'))
parts['xl/vbaProject.bin'] = ${macros}
saveFile('${input}', fflate.zipSync(parts))
`
    for (const [input, macros] of [
      ['plain.xlsm', 'new Uint8Array(16)'],
      ['SimpleMacro.xlsm', `parts['xl/vbaProject.bin'].slice().reverse()`],
    ]) {
      expect(await errorOf(save(input, macros), [input])).toStartWith(
        `"${input}" was not saved: the script added or changed the macros in xl/vbaProject.bin.`,
      )
    }
  })

  it('refuses a macro, ActiveX control or data connection the script added, whatever its content type says', async () => {
    storeAttachment('chart.xlsx', await fixture('WithChart.xlsx'))
    storeAttachment('SimpleMacro.xlsm', await fixture('SimpleMacro.xlsm'))
    const relationshipTypes = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const edit = (input: string, change: string) => `
const parts = fflate.unzipSync(readFile('${input}'))
const text = (name) => parts[name] ? fflate.strFromU8(parts[name]) : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
const relate = (part, type, target) => {
  parts[part] = fflate.strToU8(text(part).replace('</Relationships>', '<Relationship Id="rId90" Type="' + type + '" Target="' + target + '"/></Relationships>'))
}
${change}
saveFile('${input}', fflate.zipSync(parts))
`
    const cases = [
      [
        'chart.xlsx',
        `relate('xl/worksheets/_rels/sheet1.xml.rels', '${relationshipTypes}/control', '../activeX/activeX1.xml')
parts['xl/activeX/activeX1.xml'] = fflate.strToU8('<ax:ocx xmlns:ax="http://schemas.microsoft.com/office/2006/activeX" ax:classid="{8BD21D40-EC42-11CE-9E0D-00AA006002F3}" ax:persistence="persistPropertyBag"/>')`,
        'added an ActiveX control, which Office can load and run when the file opens, in xl/activeX/activeX1.xml,',
      ],
      [
        'chart.xlsx',
        `relate('xl/_rels/workbook.xml.rels', '${relationshipTypes}/connections', 'connections.xml')
parts['xl/connections.xml'] = fflate.strToU8('<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection id="1" name="q" type="4" refreshOnLoad="1"><webPr url="https://example.com/q"/></connection></connections>')`,
        'added a data connection, which Excel can refresh from outside the file, in xl/connections.xml,',
      ],
      [
        'SimpleMacro.xlsm',
        `parts['xl/vbaProject.bin'] = new Uint8Array([...parts['xl/vbaProject.bin'], 0])
parts['[Content_Types].xml'] = fflate.strToU8(text('[Content_Types].xml').replace('application/vnd.ms-office.vbaProject', 'application/octet-stream'))`,
        'added or changed the macros in xl/vbaProject.bin.',
      ],
      [
        'chart.xlsx',
        `relate('xl/_rels/workbook.xml.rels', 'http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet', 'macrosheets/m1.xml')
parts['xl/macrosheets/m1.xml'] = fflate.strToU8('<xm:macrosheet xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>EXEC("calc")</f></c></row></sheetData></xm:macrosheet>')
parts['[Content_Types].xml'] = fflate.strToU8(text('[Content_Types].xml').replace('</Types>', '<Override PartName="/xl/macrosheets/m1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'))`,
        'added or changed the macros in xl/macrosheets/m1.xml.',
      ],
    ]
    for (const [input, change, refusal] of cases) {
      expect(await errorOf(edit(input, change), [input])).toStartWith(`"${input}" was not saved: the script ${refusal}`)
    }
  })

  it('refuses a changed Power Query part, but keeps the one the workbook had', async () => {
    const parts = unzipSync(await fixture('WithChart.xlsx'))
    parts['customXml/item1.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><DataMashup xmlns="http://schemas.microsoft.com/DataMashup">AAAAAA==</DataMashup>',
    )
    storeAttachment('query.xlsx', zipSync(parts))
    const kept = `
const f = excelize.OpenReader(readFile('query.xlsx'))
f.SetCellValue(f.GetSheetList().list[0], 'Z1', 'reviewed')
saveFile('query.xlsx', f.WriteToBuffer().buffer)
`
    const { file } = await runOk(kept, ['query.xlsx'])
    expect((await partsOf(file))['customXml/item1.xml']).toEqual(parts['customXml/item1.xml'])
    const changed = `
const parts = fflate.unzipSync(readFile('query.xlsx'))
parts['customXml/item1.xml'] = fflate.strToU8(fflate.strFromU8(parts['customXml/item1.xml']).replace('AAAAAA==', 'AAAAAB=='))
saveFile('query.xlsx', fflate.zipSync(parts))
`
    expect(await errorOf(changed, ['query.xlsx'])).toStartWith(
      '"query.xlsx" was not saved: customXml/item1.xml is a Power Query (DataMashup) part, which Excel runs when its data connection refreshes, and no file the script read had that part and its relationships byte for byte.',
    )
  })

  const refusal = (name: string, part = 'xl/worksheets/sheet1.xml') =>
    `"${name}" was not saved: the script added a formula that fetches data from outside the file (WEBSERVICE, IMAGE, RTD or an IMPORT function), which Excel or Google Sheets runs when the workbook calculates, in ${part} (`

  it('refuses a formula the script added through Excelize that fetches data from outside the file', async () => {
    for (const formula of [
      'WEBSERVICE("https://example.com/?q="&B1)',
      'IMAGE("https://example.com/a.png")',
      'RTD("a.b","host","t")',
      'IMPORTDATA("https://example.com/a.csv")',
    ]) {
      const script = `const f = excelize.NewFile(); f.SetCellFormula('Sheet1', 'A1', ${JSON.stringify(formula)}); saveFile('a.xlsx', f.WriteToBuffer().buffer)`
      expect(await errorOf(script)).toStartWith(refusal('a.xlsx'))
    }
    const named = `const f = excelize.NewFile(); f.SetDefinedName({ Name: 'feed', RefersTo: '_xlfn.WEBSERVICE("https://example.com")' }); saveFile('a.xlsx', f.WriteToBuffer().buffer)`
    expect(await errorOf(named)).toStartWith(refusal('a.xlsx', 'xl/workbook.xml'))
    const conditional = `
const f = excelize.NewFile()
const style = f.NewConditionalStyle({ Font: { Color: '#9A0511' } }).style
f.SetConditionalFormat('Sheet1', 'A1:A5', [{ Type: 'formula', Criteria: 'LEN(_xlfn.WEBSERVICE("https://example.com"))>0', Format: style }])
saveFile('a.xlsx', f.WriteToBuffer().buffer)
`
    expect(await errorOf(conditional)).toStartWith(refusal('a.xlsx'))
    const scale = `
const f = excelize.NewFile()
f.SetConditionalFormat('Sheet1', 'A1:A5', [{ Type: '2_color_scale', Criteria: '=', MinType: 'formula', MinValue: 'WEBSERVICE("https://example.com")', MaxType: 'max', MinColor: '#F8696B', MaxColor: '#63BE7B' }])
saveFile('a.xlsx', f.WriteToBuffer().buffer)
`
    expect(await errorOf(scale)).toStartWith(refusal('a.xlsx'))
  })

  it('refuses a fetching formula written by hand, however the XML hides it', async () => {
    // Built by hand, so the check sees the XML exactly as written. A UTF-8 byte-order mark is valid XML too.
    for (const [cell, mark] of [
      ['<f>WEB<!-- -->SERVICE("https://example.com")</f>', ''],
      ['<f><![CDATA[_xlfn.IMAGE("https://example.com/a.png")]]></f>', ''],
      ['<f>_xlfn.WEBSERVICE("https://example.com")</f>', '\\uFEFF'],
      // A namespace prefix may hold letters outside ASCII.
      [
        '<é:f xmlns:é="http://schemas.openxmlformats.org/spreadsheetml/2006/main">_xlfn.WEBSERVICE("https://example.com")</é:f>',
        '',
      ],
    ]) {
      const script = `
const parts = fflate.unzipSync(excelize.NewFile().WriteToBuffer().buffer)
const sheet = fflate.strFromU8(parts['xl/worksheets/sheet1.xml'])
parts['xl/worksheets/sheet1.xml'] = fflate.strToU8('${mark}' + sheet.replace('<sheetData></sheetData>', '<sheetData><row r="1"><c r="A1">${cell}</c></row></sheetData>'))
saveFile('a.xlsx', fflate.zipSync(parts))
`
      expect(await errorOf(script)).toStartWith(refusal('a.xlsx'))
    }
  })

  it('keeps a fetching formula the workbook had, and look-alikes that fetch nothing', async () => {
    const engines = await loadSpreadsheetEngines(
      await packageFile('excelize-wasm/excelize.wasm.gz'),
      await packageFile('@ironcalc/wasm/wasm_bg.wasm'),
    )
    const book = engines.excelize.NewFile()
    book.SetCellFormula('Sheet1', 'A1', '_xlfn.WEBSERVICE("https://example.com/feed")')
    const { buffer } = book.WriteToBuffer()
    if (!(buffer instanceof Uint8Array)) {
      throw new Error('WriteToBuffer returned no bytes')
    }
    storeAttachment('feed.xlsx', new Uint8Array(buffer))
    const edit = (cell: string, formula: string) =>
      `const f = excelize.OpenReader(readFile('feed.xlsx')); f.SetCellFormula('Sheet1', '${cell}', ${JSON.stringify(formula)}); saveFile('feed.xlsx', f.WriteToBuffer().buffer)`
    expect((await runOk(edit('B1', 'SUM(1,2)'), ['feed.xlsx'])).output.ok).toBe(true)
    // The refusal quotes the formula, so the model can tell the user's own formula it changed from one it added.
    expect(await errorOf(edit('A1', 'WEBSERVICE("https://example.org/feed")'), ['feed.xlsx'])).toStartWith(
      `${refusal('feed.xlsx')}${JSON.stringify('_xlfn.WEBSERVICE("https://example.org/feed")')}), and no file`,
    )

    const lookalikes = `
const f = excelize.NewFile()
f.SetCellFormula('Sheet1', 'A1', 'HYPERLINK("https://example.com","open")')
f.SetCellFormula('Sheet1', 'A2', '"Image ("&B1&")"')
f.SetCellFormula('Sheet1', 'A3', 'FILTERXML(B1,"//a")')
f.SetCellFormula('Sheet1', 'A4', 'SUM(Table1[Image (URL)])')
saveFile('a.xlsx', f.WriteToBuffer().buffer)
`
    expect((await runOk(lookalikes)).output.ok).toBe(true)
  })

  it('escapes the formulas of a data validation, which Excelize writes into the sheet as they are', async () => {
    const { file } = await runOk(`
const f = excelize.NewFile()
f.AddDataValidation('Sheet1', { Sqref: 'C1', Type: 'custom', Formula1: '<injected attr="a&b"/>' })
f.AddDataValidation('Sheet1', { Sqref: 'C2', Type: 'whole', Operator: 'between', Formula1: 'A1<5', Formula2: '10' })
saveFile('valid.xlsx', f.WriteToBuffer().buffer)
`)
    const sheet = new DOMParser({ onError: onWarningStopParsing }).parseFromString(
      textOf(await partsOf(file), 'xl/worksheets/sheet1.xml'),
      'text/xml',
    )
    expect(Array.from(sheet.getElementsByTagName('formula1'), (node) => node.textContent)).toEqual([
      '<injected attr="a&b"/>',
      'A1<5',
    ])
  })

  it('refuses a workbook marked as having macros under a .xlsx name, without asking for .xlsm', async () => {
    storeAttachment('SimpleMacro.xlsm', await fixture('SimpleMacro.xlsm'))
    const error = await errorOf(`saveFile('copy.xlsx', readFile('SimpleMacro.xlsm'))`, ['SimpleMacro.xlsm'])
    expect(error).toStartWith('"copy.xlsx" is marked as a workbook with macros, which Excel does not open as .xlsx.')
    expect(error).not.toContain('as .xlsm')
  })

  it('judges the macros of a workbook by the name it is stored under, without trailing dots or spaces', async () => {
    storeAttachment('SimpleMacro.xlsm', await fixture('SimpleMacro.xlsm'))
    const edit = (name: string) => `
const f = excelize.OpenReader(readFile('SimpleMacro.xlsm'))
f.SetCellValue(f.GetSheetList().list[0], 'B2', 1200)
saveFile(${JSON.stringify(name)}, f.WriteToBuffer().buffer)
`
    for (const name of ['copy.xlsx.', 'copy.xlsx ']) {
      expect(await errorOf(edit(name), ['SimpleMacro.xlsm'])).toStartWith(
        `${JSON.stringify(name)} is marked as a workbook with macros, which Excel does not open as .xlsx.`,
      )
    }
    const plain = `saveFile('new.xlsm ', excelize.NewFile().WriteToBuffer().buffer)`
    expect(await errorOf(plain, ['SimpleMacro.xlsm'])).toStartWith(
      '"new.xlsm " has no macros, and Excel opens an .xlsm file only when it has them.',
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

  // A size refusal gets no hint to load the Excel skill, which cannot help, so a later failure still gets it.
  it('refuses to open a workbook over 2 MiB', async () => {
    storeAttachment('big.xlsx', new Uint8Array(2 * mib + 1))
    const tool = toolWith(runner, {}, [officeSkillNames.xlsx])
    const error = await failureOn(tool, `excelize.OpenReader(readFile('big.xlsx'))`, ['big.xlsx'])
    expect(error).toContain(
      'This workbook is larger than the 2 MiB excelize can open here. Stop and tell the user it is too large to edit here',
    )
    expect(error).not.toContain(loadHint)
    expect(await failureOn(tool, recoverable)).toContain(loadHint)
  })

  it('refuses a workbook that unzips past the limit', async () => {
    const bomb = zipSync({
      ...unzipSync(await fixture('WithChart.xlsx')),
      'xl/padding.xml': strToU8(' '.repeat(2 * mib)),
    })
    storeAttachment('bomb.xlsx', bomb)
    const tool = toolWith(runner, { workbookUnzipBytes: mib }, [officeSkillNames.xlsx])
    const error = await failureOn(tool, `excelize.OpenReader(readFile('bomb.xlsx'))`, ['bomb.xlsx'])
    expect(error).toContain(
      'This workbook unzips to more than 1 MiB, the most excelize can open here. Stop and tell the user it is too large to edit here',
    )
    expect(error).not.toContain(loadHint)
    expect(await failureOn(tool, recoverable)).toContain(loadHint)
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

  it('refuses a formula given to SetCellValue, and keeps text that starts with "=" through SetCellStr', async () => {
    expect(await errorOf(`excelize.NewFile().SetCellValue('Sheet1', 'F2', '=SUM(C2:E2)')`)).toContain(
      'TypeError: SetCellValue stores a value that starts with "=" as text, not as a formula. Write a formula with SetCellFormula, without the "=", or use SetCellStr for text that must start with "=".',
    )
    const { file } = await runOk(`
const f = excelize.NewFile()
f.SetCellStr('Sheet1', 'A1', '=not a formula')
f.SetCellValue('Sheet1', 'A2', 'a = b')
saveFile('text.xlsx', f.WriteToBuffer().buffer)
`)
    const [{ data }] = await rowsOf(file)
    expect(data).toEqual([['=not a formula'], ['a = b']])
    expect(textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')).not.toContain('<f>')
  })

  it('refuses conditional-format rules that are not an array', async () => {
    const setRules = (rules: string) => `
const f = excelize.NewFile()
const style = f.NewConditionalStyle({ Font: { Color: '#9C0006' } }).style
f.SetConditionalFormat('Sheet1', 'A2:F13', ${rules})
`
    const expected =
      'TypeError: SetConditionalFormat takes its rules as an array: f.SetConditionalFormat(sheet, "A2:F13", [{ Type: "formula", Criteria: "$F2>$B2", Format: style }]).'
    expect(await errorOf(setRules(`{ Type: 'formula', Criteria: '$F2>$B2', Format: style }`))).toContain(expected)
    expect(
      await errorOf(setRules(`JSON.stringify([{ Type: 'formula', Criteria: '$F2>$B2', Format: style }])`)),
    ).toContain(expected)
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
  () => __workbook(0, 'OpenReader', '[{"__bytes":0}]', new Uint8Array(4), new Uint8Array(4)),
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
        'A workbook call takes at most one Uint8Array. Pass the bytes once, in the one argument that takes them.',
        'SetCellValue: invalid argument data type: argument 3 is null, where Excelize takes a string or a number or a boolean',
        'undefined undefined function function',
        '',
      ].join('\n'),
    )
  })
})

// Once, not in both runners: the pattern scan these guard is the same code whether or not `Symbol.dispose` exists.
describe('run_office_script storing formula results', () => {
  // JavaScriptCore stopped matching a sheetData from about 0.65 MiB with a pattern that tested every character of
  // it. Thirty rows of 28,000 characters reach 0.8 MiB with few formulas to compute.
  it('stores the results of a sheet part of 0.8 MiB', async () => {
    const { output, file } = await runOkWith(
      inProcess,
      `
const parts = fflate.unzipSync(excelize.NewFile().WriteToBuffer().buffer)
const rows = Array.from({ length: 30 }, (_, i) => {
  const r = i + 1
  return '<row r="' + r + '"><c r="A' + r + '"><v>' + r + '</v></c><c r="B' + r + '" t="str"><v>' + 'x'.repeat(28000) + '</v></c><c r="C' + r + '"><f>A' + r + '*2</f></c></row>'
})
const sheet = fflate.strFromU8(parts['xl/worksheets/sheet1.xml'])
parts['xl/worksheets/sheet1.xml'] = fflate.strToU8(sheet.replace('<sheetData></sheetData>', '<sheetData>' + rows.join('') + '</sheetData>'))
saveFile('long.xlsx', excelize.OpenReader(fflate.zipSync(parts, { level: 0 })).WriteToBuffer().buffer)
`,
    )
    const sheet = textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')
    expect(sheet.length).toBeGreaterThan(0.8 * mib)
    expect(output.formulaErrors).toBeUndefined()
    expect(count(sheet, /<f>A\d+\*2<\/f><v>\d+<\/v>/g)).toBe(30)
    expect(sheet).toContain('<c r="C30"><f>A30*2</f><v>60</v></c>')
  })

  it('computes a cell whose XML holds a comment with a cell tag', async () => {
    const { output, file } = await runOkWith(
      inProcess,
      `
const parts = fflate.unzipSync(excelize.NewFile().WriteToBuffer().buffer)
const cells = '<row r="1"><c r="A1" t="str"><f>1+1</f><!-- <c> --></c><c r="B1" t="str"><f>A1+2</f></c></row>'
const sheet = fflate.strFromU8(parts['xl/worksheets/sheet1.xml'])
parts['xl/worksheets/sheet1.xml'] = fflate.strToU8(sheet.replace('<sheetData></sheetData>', '<sheetData>' + cells + '</sheetData>'))
saveFile('comment.xlsx', excelize.OpenReader(fflate.zipSync(parts)).WriteToBuffer().buffer)
`,
    )
    const sheet = textOf(await partsOf(file), 'xl/worksheets/sheet1.xml')
    expect(output.formulaErrors).toBeUndefined()
    expect(sheet).toContain('<f>1+1</f><v>2</v>')
    expect(sheet).toContain('<f>A1+2</f><v>4</v>')
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
