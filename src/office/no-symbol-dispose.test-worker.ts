/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Test only: a Bun Worker that runs the sandbox as system WebKit on macOS 26.4 and iOS 26.5 would, with no
 * `Symbol.dispose`. Bun's own `Symbol.dispose` can't be deleted, so the global `Symbol` is replaced by a
 * stand-in that inherits everything else from it. A Worker has its own module graph, so quickjs-wasi loads
 * fresh here, after the swap.
 */
import type { SandboxLimits } from './constants'

const nativeSymbol = Symbol
const standIn = Object.setPrototypeOf((description?: string) => nativeSymbol(description), nativeSymbol)
Object.defineProperties(standIn, {
  dispose: { value: undefined, writable: true },
  asyncDispose: { value: undefined, writable: true },
})
Object.defineProperty(globalThis, 'Symbol', { value: standIn, writable: true, configurable: true })

// Dynamic, so the modules load after the swap above; static imports would run first.
const { runSandboxedScript } = await import('./sandbox')
const { loadTestSandboxRuntime } = await import('./sandbox-test-runtime')
const runtime = await loadTestSandboxRuntime()

self.onmessage = async ({ data }: MessageEvent<{ script: string; limits: SandboxLimits }>) => {
  self.postMessage(await runSandboxedScript(runtime, data.script, data.limits))
}
// Messages posted before the handler above exists are dropped, so the test waits for this one.
self.postMessage('ready')
