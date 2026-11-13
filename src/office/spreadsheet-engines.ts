/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import initIronCalc, { Model } from '@ironcalc/wasm'
// Imported for its side effect: it defines Go's standard WebAssembly runtime, `globalThis.Go`.
import 'excelize-wasm'
import type { init } from 'excelize-wasm'
import { gunzipSync } from 'fflate'

export type Excelize = Awaited<ReturnType<typeof init>>

/** An open workbook in Excelize. */
export type ExcelizeFile = ReturnType<Excelize['NewFile']>

type GoRuntime = { importObject: WebAssembly.Imports; run: (instance: WebAssembly.Instance) => Promise<void> }

// The globals excelize-wasm's loader uses. Their names are the library's, so `Go` keeps its capital.
declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var Go: new () => GoRuntime
  var excelize: Excelize
}

/** Excelize opens and saves workbooks; IronCalc computes their formulas. Both run outside the sandbox VM. */
export type SpreadsheetEngines = {
  excelize: Excelize
  /** Excelize's memory. WebAssembly memory never shrinks, so its size is the most the run has used. */
  excelizeMemory: WebAssembly.Memory
  ironcalc: typeof Model
}

/** True when the bytes start with the gzip magic number. */
const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b

/**
 * Start Excelize and IronCalc from their WebAssembly files. This is what excelize-wasm's `init` does, minus the
 * fetch, so the caller chooses where the bytes come from and keeps Excelize's memory to measure it. The file is
 * the package's gzip; a server that already decompressed it sends the plain module.
 */
export const loadSpreadsheetEngines = async (
  excelizeWasm: Uint8Array<ArrayBuffer>,
  ironcalcWasm: BufferSource,
): Promise<SpreadsheetEngines> => {
  await initIronCalc({ module_or_path: ironcalcWasm })
  const go = new Go()
  globalThis.excelize = {} as Excelize
  const { instance } = await WebAssembly.instantiate(
    isGzip(excelizeWasm) ? gunzipSync(excelizeWasm) : excelizeWasm,
    go.importObject,
  )
  // Settles only when the Go program exits, which it never does. By the time it returns, it has filled `excelize`.
  void go.run(instance)
  return { excelize: globalThis.excelize, excelizeMemory: instance.exports.mem as WebAssembly.Memory, ironcalc: Model }
}
