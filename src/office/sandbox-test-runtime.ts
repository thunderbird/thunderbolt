/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import path from 'node:path'
import type { SandboxRuntime } from './sandbox'

/** A file that sits next to a package's entry point. The packages' `exports` maps hide these files. */
const besideEntry = (specifier: string, filename: string) =>
  path.join(path.dirname(Bun.resolveSync(specifier, import.meta.dir)), filename)

const compileFile = async (file: string) => WebAssembly.compile(await Bun.file(file).arrayBuffer())

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
})
