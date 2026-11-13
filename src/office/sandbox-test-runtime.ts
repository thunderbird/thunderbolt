/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import path from 'node:path'
import { bundleSandboxScript } from './bundle-sandbox-script'
import type { SandboxRuntime } from './sandbox'
import { loadSpreadsheetEngines } from './spreadsheet-engines'
import { installWorkbooks } from './workbook-bridge'

/** A file that sits next to a package's entry point. The packages' `exports` maps hide these files. */
const besideEntry = (specifier: string, filename: string) =>
  path.join(path.dirname(Bun.resolveSync(specifier, import.meta.dir)), filename)

const compileFile = async (file: string) => WebAssembly.compile(await Bun.file(file).arrayBuffer())

const readPackageFile = async (specifier: string) =>
  new Uint8Array(await Bun.file(Bun.resolveSync(specifier, import.meta.dir)).arrayBuffer())

/** Fresh engines for each run, as the app's one-run Worker has. */
const loadWorkbooks: SandboxRuntime['loadWorkbooks'] = async () => {
  const engines = await loadSpreadsheetEngines(
    await readPackageFile('excelize-wasm/excelize.wasm.gz'),
    await readPackageFile('@ironcalc/wasm/wasm_bg.wasm'),
  )
  return (vm, limits, stop) => installWorkbooks(vm, engines, limits, stop)
}

/**
 * Test only: the same files `office-script.worker.ts` fetches in the app (see the aliases in
 * `vite.config.ts`), read from `node_modules` so Bun can run the real VM and the real libraries.
 */
export const loadTestSandboxRuntime = async (): Promise<SandboxRuntime> => ({
  wasm: await compileFile(Bun.resolveSync('quickjs-wasi/quickjs.wasm', import.meta.dir)),
  extensions: [
    { name: 'encoding', wasm: await compileFile(Bun.resolveSync('quickjs-wasi/encoding.so', import.meta.dir)) },
  ],
  libraries: [
    await Bun.file(besideEntry('docx', 'index.umd.cjs')).text(),
    await Bun.file(besideEntry('pptxgenjs', 'pptxgen.bundle.js')).text(),
  ],
  ooxmlLibrary: await bundleSandboxScript(path.join(import.meta.dir, 'ooxml-globals.ts')),
  loadWorkbooks,
})
