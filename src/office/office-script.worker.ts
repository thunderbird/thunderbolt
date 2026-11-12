/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '../lib/install-webkit-own-property'

// Real files served by the app: the app CSP and the Tauri webviews block blob: and data: Workers.
import docxUrl from 'office-sandbox-docx/index.umd.cjs?url'
import pptxgenjsUrl from 'office-sandbox-pptxgenjs/pptxgen.bundle.js?url'
import encodingUrl from 'quickjs-wasi/encoding.so?url'
import quickjsUrl from 'quickjs-wasi/quickjs.wasm?url'
import { runSandboxedScript, type SandboxResult } from './sandbox'

const compile = async (url: string) => WebAssembly.compile(await (await fetch(url)).arrayBuffer())

const loadText = async (url: string) => (await fetch(url)).text()

const run = async (script: string): Promise<SandboxResult> => {
  try {
    const [wasm, encoding, docx, pptxgenjs] = await Promise.all([
      compile(quickjsUrl),
      compile(encodingUrl),
      loadText(docxUrl),
      loadText(pptxgenjsUrl),
    ])
    const runtime = { wasm, extensions: [{ name: 'encoding', wasm: encoding }], libraries: [docx, pptxgenjs] }
    return await runSandboxedScript(runtime, script)
  } catch (error) {
    return { ok: false, error: `The sandbox failed to run: ${String(error)}`, logs: '' }
  }
}

/** One run per Worker: the host terminates it afterwards, which also frees the WASM memory. */
self.onmessage = async ({ data }: MessageEvent<string>) => {
  const result = await run(data)
  self.postMessage(result, { transfer: result.ok ? result.files.map(({ bytes }) => bytes.buffer) : [] })
}
