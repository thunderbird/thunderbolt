/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import './symbol-dispose-polyfill'
import { type ExtensionDescriptor, type JSValueHandle, QuickJS } from 'quickjs-wasi'
import { type SandboxLimits, sandboxLimits } from './constants'

/** Everything a run needs: the QuickJS module, its extensions, and the library scripts evaluated before the script. */
export type SandboxRuntime = {
  wasm: WebAssembly.Module
  extensions: ExtensionDescriptor[]
  libraries: string[]
}

export type SavedFile = { filename: string; bytes: Uint8Array<ArrayBuffer> }

export type SandboxResult = { ok: true; files: SavedFile[]; logs: string } | { ok: false; error: string; logs: string }

/*
 * Globals the script and the libraries see. A bare QuickJS VM has no console and no timers. jszip (inside
 * pptxgenjs) calls setTimeout, so timers run on a virtual clock that the host loop advances: nothing waits.
 * Wrapped in a function so its names cannot clash with a library's top-level declarations.
 */
const prelude = `(() => {
  globalThis.self = globalThis
  const print = (...values) => __print(values.map(String).join(' ') + '\\n')
  globalThis.console = { log: print, info: print, warn: print, error: print, debug: print }
  const timers = new Map()
  let clock = 0
  let lastId = 0
  globalThis.setTimeout = (callback, delay, ...args) => {
    lastId += 1
    timers.set(lastId, { callback, args, at: clock + Math.max(0, Number(delay) || 0) })
    return lastId
  }
  globalThis.clearTimeout = (id) => { timers.delete(id) }
  globalThis.setImmediate = (callback, ...args) => setTimeout(callback, 0, ...args)
  globalThis.clearImmediate = clearTimeout
  globalThis.__runNextTimer = () => {
    let next
    for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry
    if (!next) return false
    timers.delete(next[0])
    clock = next[1].at
    next[1].callback(...next[1].args)
    return true
  }
  globalThis.saveFile = (filename, data) => {
    if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
      throw new TypeError('saveFile(filename, bytes) needs the bytes as a Uint8Array or an ArrayBuffer')
    }
    __saveFile(String(filename), data instanceof Uint8Array ? data : new Uint8Array(data))
  }
})()`

const shownCharacters = 20_000

/** Text from the script goes back to the model and into the chat, so only its start is kept. */
const clip = (text: string) =>
  text.length > shownCharacters ? `${text.slice(0, shownCharacters)}\n[The rest is not shown.]` : text

/**
 * Run `script` (the body of an async function) in a fresh QuickJS VM with no network, no DOM and no app
 * state. The script hands files back with `saveFile(filename, bytes)`. Every failure, including each limit,
 * returns an error worded for the model to act on.
 */
export const runSandboxedScript = async (
  runtime: SandboxRuntime,
  script: string,
  limits: SandboxLimits = sandboxLimits,
): Promise<SandboxResult> => {
  const deadline = performance.now() + limits.timeoutMs
  const encoder = new TextEncoder()
  const files: SavedFile[] = []
  let logs = ''
  let textBytes = 0
  let savedBytes = 0
  let stopped: string | null = null
  let finished: { error?: string } | null = null

  const vm = await QuickJS.create({
    wasm: runtime.wasm,
    extensions: runtime.extensions,
    memoryLimit: limits.memoryBytes,
    interruptHandler: () => {
      if (!stopped && performance.now() > deadline) {
        stopped = `The script ran for more than ${limits.timeoutMs / 1000} seconds and was stopped. Make it do less work, or build the file in several smaller runs.`
      }
      return stopped !== null
    },
  })
  try {
    const define = (name: string, fn: (...args: JSValueHandle[]) => void) => {
      const handle = vm.newFunction(name, (...args) => {
        fn(...args)
        return vm.undefined
      })
      vm.setProp(vm.global, name, handle)
      handle.dispose()
    }
    define('__print', (text) => {
      const line = text.toString()
      textBytes += encoder.encode(line).length
      if (textBytes > limits.textOutputBytes) {
        stopped ??= `The script printed more than ${limits.textOutputBytes / 1024 / 1024} MiB of text and was stopped. Print less.`
        return
      }
      logs += line
    })
    // The copies live outside the VM, so its memory limit does not see them; they count against it here.
    define('__saveFile', (filename, bytes) => {
      const name = filename.toString()
      const copy = new Uint8Array(bytes.toArrayBuffer())
      savedBytes += name.length + copy.byteLength
      if (savedBytes > limits.memoryBytes) {
        stopped ??= `The script saved more than ${limits.memoryBytes / 1024 / 1024} MiB of files and was stopped. Build smaller files.`
        return
      }
      files.push({ filename: name, bytes: copy })
    })
    define('__finish', (error) => {
      finished = error ? { error: error.toString() } : {}
    })

    vm.evalCode(prelude, 'prelude.js').dispose()
    runtime.libraries.forEach((code, index) => vm.evalCode(code, `library-${index}.js`).dispose())
    // Same line as the script's first line, so line numbers in its errors match what the model wrote.
    vm.evalCode(
      `(async () => {${script}\n})().then(() => __finish(), (error) => __finish(error instanceof Error ? error.name + ': ' + error.message + '\\n' + (error.stack ?? '') : String(error)))`,
      'script.js',
    ).dispose()
    while (!finished) {
      vm.executePendingJobs()
      if (!finished && !vm.evalCode('__runNextTimer()').consume((handle) => handle.toBoolean())) {
        finished = {
          error:
            'The script never finished. It waits on something the sandbox does not have: there is no network, no DOM, no fetch and no real timers.',
        }
      }
    }
  } catch (error) {
    // The VM throws on the host side for an interrupt, a syntax error or an exception outside a promise.
    finished = {
      error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error),
    }
  } finally {
    vm.dispose()
  }

  const shownLogs = clip(logs)
  const error = stopped ?? finished?.error
  if (error === undefined) {
    return { ok: true, files, logs: shownLogs }
  }
  if (/out of memory/i.test(error)) {
    return {
      ok: false,
      error: `The script used more than ${limits.memoryBytes / 1024 / 1024} MiB of memory and was stopped. Build a smaller file, or keep fewer copies of large data.`,
      logs: shownLogs,
    }
  }
  return { ok: false, error: clip(error), logs: shownLogs }
}
