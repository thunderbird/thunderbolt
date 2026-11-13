/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { QuickJS } from 'quickjs-wasi'
import { z } from 'zod'
import type { SandboxLimits } from './constants'
import { cacheFormulaResults, type FormulaError, type WorkbookParts } from './formula-cache'
import type { Excelize, ExcelizeFile, SpreadsheetEngines } from './spreadsheet-engines'

/** What crosses between the script and Excelize: plain data and bytes. */
export type WorkbookValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | WorkbookValue[]
  | { [key: string]: WorkbookValue }

// Bytes first: a Uint8Array would also pass as a record of its indexes.
const workbookValue: z.ZodType<WorkbookValue> = z.lazy(() =>
  z.union([
    z.instanceof(Uint8Array),
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(workbookValue),
    z.record(z.string(), workbookValue),
  ]),
)

const workbookArguments = z.array(workbookValue)

/** Where the shim's JSON holds a Uint8Array argument: the index of the bytes passed beside it. */
const bytesMarker = z.object({ __bytes: z.number().int() }).strict()

const failure = z.object({ error: z.string().min(1) })

/** The Excelize options a script may give when it opens or creates a workbook. Unknown ones, `TmpDir` among them, are dropped. */
const fileOptions = z
  .object({
    MaxCalcIterations: z.number(),
    Password: z.string(),
    RawCellValue: z.boolean(),
    ShortDatePattern: z.string(),
    LongDatePattern: z.string(),
    LongTimePattern: z.string(),
    CultureInfo: z.number(),
  })
  .partial()

const parseOptions = (call: string, value: WorkbookValue) => {
  const parsed = fileOptions.safeParse(value ?? {})
  if (!parsed.success) {
    throw new TypeError(`${call} got options it cannot use: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

const formulaArguments = z.tuple([z.string(), z.string(), z.string()]).rest(workbookValue)

type WorkbookFunction = (...args: WorkbookValue[]) => WorkbookValue

/** An Excelize object's own functions, by name, bound to it. */
const functionsOf = (target: Excelize | ExcelizeFile) =>
  new Map<string, WorkbookFunction>(
    Object.entries(target).flatMap(([name, value]) => (value instanceof Function ? [[name, value.bind(target)]] : [])),
  )

/**
 * The workbook API as the script sees it: a global `excelize` whose calls all go through `__workbook`. Arguments
 * cross as JSON, with each Uint8Array passed beside it, so the VM pays for building them: a host-side copy of a
 * guest value could be far larger than the value, as a sparse array is.
 */
const shim = (helpers: string[], constants: string) => `(() => {
  const host = __workbook
  const call = (handle, method, args) => {
    const bytes = []
    const json = JSON.stringify(args, (key, value) => {
      if (value instanceof ArrayBuffer) value = new Uint8Array(value)
      return value instanceof Uint8Array ? { __bytes: bytes.push(value) - 1 } : value
    })
    return host(handle, method, json ?? '[]', ...bytes)
  }
  const workbook = ({ handle, methods }) =>
    Object.freeze(Object.fromEntries(methods.map((name) => [name, (...args) => call(handle, name, args)])))
  globalThis.excelize = Object.freeze({
    ...${constants},
    ...Object.fromEntries(${JSON.stringify(helpers)}.map((name) => [name, (...args) => call(0, name, args)])),
    NewFile: (...args) => workbook(call(0, 'NewFile', args)),
    OpenReader: (...args) => workbook(call(0, 'OpenReader', args)),
  })
})()`

/** A byte count in MiB, to one decimal, for messages. */
const mib = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`

/** Excelize reports a failure in the result's `error`, which a script easily ignores. Here it becomes a thrown Error. */
const settle = <T>(call: string, result: T): T => {
  const failed = failure.safeParse(result)
  if (failed.success) {
    throw new Error(`${call}: ${failed.data.error}`)
  }
  return result
}

const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const macroWorkbookType = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'

/**
 * Excelize's buffer keeps the workbook's content type, even after `AddVBAProject`, and Excel opens a workbook with
 * macros only under the macro type. The output check then holds the file name to it: .xlsm for this type.
 */
const markMacros = (parts: WorkbookParts) => {
  const types = strFromU8(parts['[Content_Types].xml'] ?? new Uint8Array())
  if (Object.keys(parts).some((name) => /(^|\/)vbaProject\.bin$/i.test(name)) && types.includes(workbookType)) {
    parts['[Content_Types].xml'] = strToU8(types.replace(workbookType, macroWorkbookType))
  }
}

/** True when two byte arrays hold the same bytes. */
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i])

const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b

/**
 * The parts of a saved workbook that are byte for byte the same as in the file it was opened from: Excelize copied
 * them without parsing them. A password-protected original is no zip to compare with, so every part counts as copied.
 */
const copiedFrom = (input: Uint8Array | undefined, parts: WorkbookParts) => {
  if (!input) {
    return []
  }
  if (!isZip(input)) {
    return Object.keys(parts)
  }
  const original = unzipSync(input)
  return Object.keys(parts).filter((name) => original[name] && sameBytes(original[name], parts[name]))
}

type OpenWorkbook = {
  file: ExcelizeFile
  calls: Map<string, WorkbookFunction>
  /** The bytes it was opened from. A new workbook has none. */
  input?: Uint8Array
}

/**
 * What a `WriteToBuffer` call returned: the bytes, the formulas it could not compute, and the parts Excelize copied
 * from the opened bytes without parsing them. Those may hold XML that does not parse, so the output check still
 * parses them; every other part is Excelize's own.
 */
export type SavedWorkbook = { bytes: Uint8Array; formulaErrors: FormulaError[]; copiedParts: string[] }

/**
 * Give a VM the workbook API. Workbooks stay in Excelize, outside the VM; the script holds a handle and passes
 * plain values and bytes, checked as they arrive. Only Excelize's workbook calls and its pure helpers are
 * reachable. A workbook opens only under the size limits, a new one names Microsoft Excel as its application, and
 * saving one computes its formulas first (see `cacheFormulaResults`). `stop` ends the run once Excelize's memory
 * passes its limit.
 */
export const installWorkbooks = (
  vm: QuickJS,
  { excelize, excelizeMemory, ironcalc }: SpreadsheetEngines,
  limits: SandboxLimits,
  stop: (reason: string) => void,
) => {
  const workbooks: OpenWorkbook[] = []
  // Bounded like the files a script saves, oldest out first: a buffer saved after it fell out is checked in full.
  const saves: SavedWorkbook[] = []
  const helpers = functionsOf(excelize)
  helpers.delete('NewFile')
  helpers.delete('OpenReader')
  const constants = Object.fromEntries(Object.entries(excelize).filter(([, value]) => Number.isFinite(value)))

  const handleOf = (file: ExcelizeFile, input?: Uint8Array) => {
    const calls = functionsOf(file)
    return { handle: workbooks.push({ file, calls, input }), methods: [...calls.keys()] }
  }

  const open = (bytes: WorkbookValue, options: WorkbookValue) => {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(
        'excelize.OpenReader(bytes) needs the workbook as a Uint8Array, as readFile(name) returns it.',
      )
    }
    if (bytes.byteLength > limits.maxWorkbookBytes) {
      throw new Error(
        `This workbook is larger than the ${mib(limits.maxWorkbookBytes)} excelize can open here. Stop and tell the user it is too large to edit here; do not rebuild or unzip it.`,
      )
    }
    const file = excelize.OpenReader(bytes, {
      ...parseOptions('OpenReader', options),
      UnzipSizeLimit: limits.workbookUnzipBytes,
      // Equal to the size limit, so Excelize never moves a large sheet to a temporary file, which the browser lacks.
      UnzipXMLSizeLimit: limits.workbookUnzipBytes,
    })
    if (/unzip size exceeds/.test(file.error ?? '')) {
      throw new Error(
        `This workbook unzips to more than ${mib(limits.workbookUnzipBytes)}, the most excelize can open here. Stop and tell the user it is too large to edit here; do not rebuild or unzip it.`,
      )
    }
    return handleOf(settle('OpenReader', file), bytes)
  }

  const create = (options: WorkbookValue) => {
    const file = settle('NewFile', excelize.NewFile(parseOptions('NewFile', options)))
    // LibreOffice draws some charts differently for an application it does not know, such as "Go Excelize".
    settle('SetAppProps', file.SetAppProps({ Application: 'Microsoft Excel' }))
    return handleOf(file)
  }

  const save = (workbook: OpenWorkbook, options: WorkbookValue) => {
    // A password would encrypt the file, and an encrypted file can be neither checked nor previewed.
    if (options !== undefined) {
      throw new TypeError('WriteToBuffer takes no options here, so a workbook cannot be saved with a password.')
    }
    const { buffer } = settle('WriteToBuffer', workbook.file.WriteToBuffer())
    if (!(buffer instanceof Uint8Array)) {
      throw new Error('WriteToBuffer returned no bytes.')
    }
    const parts = unzipSync(buffer)
    const copiedParts = copiedFrom(workbook.input, parts)
    const formulaErrors = cacheFormulaResults(workbook.file, parts, ironcalc)
    markMacros(parts)
    const saved = { bytes: zipSync(parts), formulaErrors, copiedParts }
    saves.push(saved)
    while (saves.reduce((total, { bytes }) => total + bytes.byteLength, 0) > limits.memoryBytes) {
      saves.shift()
    }
    // The script can check the formulas before it saves anything, so it needs no test files to find out.
    return { buffer: saved.bytes, formulaErrors, error: null }
  }

  /**
   * The function behind one call from the script: handle 0 is the `excelize` global, any other a workbook it opened
   * or created. It is found before the arguments are parsed, so a call to a missing method parses nothing.
   */
  const target = (handle: number, method: string): WorkbookFunction => {
    if (handle === 0) {
      if (method === 'NewFile') {
        return (options) => create(options)
      }
      if (method === 'OpenReader') {
        return (bytes, options) => open(bytes, options)
      }
      const helper = helpers.get(method)
      if (!helper) {
        throw new TypeError(`excelize.${method} is not a function.`)
      }
      return (...args) => settle(method, helper(...args))
    }
    const workbook = workbooks[handle - 1]
    const workbookCall = workbook?.calls.get(method)
    if (!workbook || !workbookCall) {
      throw new TypeError(`A workbook has no method ${method}.`)
    }
    if (method === 'WriteToBuffer') {
      return (options) => save(workbook, options ?? undefined)
    }
    return (...args) => {
      const formula = method === 'SetCellFormula' ? formulaArguments.safeParse(args) : undefined
      if (!formula?.success) {
        return settle(method, workbookCall(...args))
      }
      // Excelize's own examples start a formula with "=", which it keeps and Excel then refuses.
      const [sheet, cell, text, ...rest] = formula.data
      return settle(method, workbookCall(sheet, cell, text.replace(/^=/, ''), ...rest))
    }
  }

  /** The arguments as the shim sent them: JSON, with each Uint8Array passed beside it. */
  const parseArguments = (json: string, bytes: Uint8Array[]) => {
    const invalid = new TypeError(
      'Workbook calls take strings, numbers, booleans, arrays, objects and Uint8Array bytes.',
    )
    try {
      const parsed = workbookArguments.safeParse(
        JSON.parse(json, (_, value) => {
          const marker = bytesMarker.safeParse(value)
          return marker.success ? bytes[marker.data.__bytes] : value
        }),
      )
      if (parsed.success) {
        return parsed.data
      }
    } catch {
      // Not JSON: only a script that skips the shim sends that.
    }
    throw invalid
  }

  // The VM takes its own reference to a returned handle, so each call releases the previous one, as `readFile` does.
  let lastResult: ReturnType<QuickJS['hostToHandle']> | undefined
  const host = vm.newFunction('__workbook', (handle, method, json, ...bytesHandles) => {
    const run = target(handle.toNumber(), method.toString())
    const bytes = bytesHandles.map((bytesHandle) => new Uint8Array(bytesHandle.toArrayBuffer()))
    const result = run(...parseArguments(json.toString(), bytes))
    if (excelizeMemory.buffer.byteLength > limits.workbookMemoryBytes) {
      stop(
        `Excelize used more than ${mib(limits.workbookMemoryBytes)} of memory and the run was stopped. Work on fewer cells in one run, or on a smaller workbook.`,
      )
    }
    lastResult?.dispose()
    lastResult = vm.hostToHandle(result)
    return lastResult
  })
  vm.setProp(vm.global, '__workbook', host)
  host.dispose()
  vm.evalCode(shim([...helpers.keys()], JSON.stringify(constants)), 'excelize.js').dispose()

  /** The `WriteToBuffer` result that gave exactly these bytes, or `undefined` when they did not come from one unchanged. */
  return (bytes: Uint8Array) => saves.findLast((saved) => sameBytes(saved.bytes, bytes))
}
