/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '../lib/install-webkit-own-property'

// Real files served by the app: the app CSP and the Tauri webviews block blob: and data: Workers.
import ironcalcUrl from '@ironcalc/wasm/wasm_bg.wasm?url'
import docxUrl from 'office-sandbox-docx/index.umd.cjs?url'
import excelizeUrl from 'excelize-wasm/excelize.wasm.gz?url'
import pptxgenjsUrl from 'office-sandbox-pptxgenjs/pptxgen.bundle.js?url'
import encodingUrl from 'quickjs-wasi/encoding.so?url'
import quickjsUrl from 'quickjs-wasi/quickjs.wasm?url'
import { sandboxLimits } from './constants'
// Bundled into the Worker's own chunk as one script: xmldom ships only CommonJS files, which the VM cannot load.
// The script VM and the output check both evaluate it; the Worker never imports the libraries itself.
import ooxmlScript from './ooxml-globals.ts?sandbox-script'
import type { SandboxMessage } from './run-in-worker'
import { type InstallWorkbooks, runSandboxedScript, type SandboxJob, type SandboxResult } from './sandbox'

const compile = async (url: string) => WebAssembly.compile(await (await fetch(url)).arrayBuffer())

const loadText = async (url: string) => (await fetch(url)).text()

const loadBytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer())

/** Excelize, IronCalc and the code around them load only for a script that uses a workbook. */
const loadWorkbooks = async (): Promise<InstallWorkbooks> => {
  const [{ loadSpreadsheetEngines }, { installWorkbooks }, excelizeWasm, ironcalcWasm] = await Promise.all([
    import('./spreadsheet-engines'),
    import('./workbook-bridge'),
    loadBytes(excelizeUrl),
    loadBytes(ironcalcUrl),
  ])
  const engines = await loadSpreadsheetEngines(excelizeWasm, ironcalcWasm)
  return (vm, limits, stop) => installWorkbooks(vm, engines, limits, stop)
}

const run = async (job: SandboxJob): Promise<SandboxResult> => {
  try {
    const [wasm, encoding, docx, pptxgenjs] = await Promise.all([
      compile(quickjsUrl),
      compile(encodingUrl),
      loadText(docxUrl),
      loadText(pptxgenjsUrl),
    ])
    const runtime = {
      wasm,
      extensions: [{ name: 'encoding', wasm: encoding }],
      libraries: [docx, pptxgenjs],
      ooxmlLibrary: ooxmlScript,
      loadWorkbooks,
    }
    return await runSandboxedScript(runtime, job, sandboxLimits, () =>
      self.postMessage('ready' satisfies SandboxMessage),
    )
  } catch (error) {
    return { ok: false, error: `The sandbox failed to run: ${String(error)}`, logs: '' }
  }
}

/** One run per Worker: the host terminates it afterwards, which also frees the WASM memory, Excelize's included. */
self.onmessage = async ({ data }: MessageEvent<SandboxJob>) => {
  const result = await run(data)
  self.postMessage(result, { transfer: result.ok ? result.files.map(({ bytes }) => bytes.buffer) : [] })
}
