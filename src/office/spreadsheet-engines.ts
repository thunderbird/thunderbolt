/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import initIronCalc, { Model } from '@ironcalc/wasm'
import { type Excelize, loadExcelize } from './excelize-engine'

/** Excelize opens and saves workbooks; IronCalc computes their formulas. Both run outside the sandbox VM. */
export type SpreadsheetEngines = {
  excelize: Excelize
  /** Excelize's memory. WebAssembly memory never shrinks, so its size is the most the run has used. */
  excelizeMemory: WebAssembly.Memory
  ironcalc: typeof Model
}

/** Start Excelize and IronCalc from their WebAssembly files. The spreadsheet preview loads Excelize alone. */
export const loadSpreadsheetEngines = async (
  excelizeWasm: Uint8Array<ArrayBuffer>,
  ironcalcWasm: BufferSource,
): Promise<SpreadsheetEngines> => {
  await initIronCalc({ module_or_path: ironcalcWasm })
  return { ...(await loadExcelize(excelizeWasm)), ironcalc: Model }
}
