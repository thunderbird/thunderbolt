/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import './symbol-dispose-polyfill'
import { type ExtensionDescriptor, type JSValueHandle, QuickJS } from 'quickjs-wasi'
import { findBrokenFile } from './check-output'
import { type SandboxLimits, sandboxLimits } from './constants'
import type { FormulaError } from './formula-cache'
import type { SavedWorkbook } from './workbook-bridge'

/**
 * Gives a VM the `excelize` workbook API (see `installWorkbooks`). `stop` ends the run with a reason. Returns a
 * lookup from saved bytes to the `WriteToBuffer` result they are, `undefined` for bytes that are not one unchanged.
 */
export type InstallWorkbooks = (
  vm: QuickJS,
  limits: SandboxLimits,
  stop: (reason: string) => void,
) => (bytes: Uint8Array) => SavedWorkbook | undefined

/** A formula a saved workbook could not compute, with the name the script saved the workbook under. */
export type FileFormulaError = FormulaError & { file: string }

/** Everything a run needs: the QuickJS module, its extensions, and the library scripts evaluated before the script. */
export type SandboxRuntime = {
  wasm: WebAssembly.Module
  extensions: ExtensionDescriptor[]
  libraries: string[]
  /** The `fflate` and `xmldom` script. The script's VM evaluates it after `libraries`; the check VM evaluates only it. */
  ooxmlLibrary: string
  /** Loads Excelize and IronCalc, which only a script that uses `excelize` waits for: they are several megabytes. */
  loadWorkbooks: () => Promise<InstallWorkbooks>
}

export type SavedFile = { filename: string; bytes: Uint8Array<ArrayBuffer> }

/** A file the script reads with `readFile(name)`, under the name it gave in the tool call's `inputs`. */
export type SandboxInput = { name: string; bytes: Uint8Array<ArrayBuffer> }

/** What one run executes: the script and the files it may read. */
export type SandboxJob = { script: string; inputs: SandboxInput[] }

export type SandboxResult =
  | { ok: true; files: SavedFile[]; logs: string; formulaErrors?: FileFormulaError[] }
  | { ok: false; error: string; logs: string }

/** How many formula errors a result lists, so a broken workbook cannot flood the model's context. */
export const maxFormulaErrors = 50

/** A script that names `excelize` is about to open or create a workbook. */
const usesWorkbooks = (script: string) => /\bexcelize\b/.test(script)

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
  globalThis.readFile = (name) => {
    const bytes = __readFile(String(name))
    if (bytes === undefined) {
      throw new Error('"' + name + '" is not one of this run\\'s inputs. Add it to inputs and call the tool again.')
    }
    return bytes
  }
})()`

const shownCharacters = 20_000

/** Text from the script goes back to the model and into the chat, so only its start is kept. */
const clip = (text: string) =>
  text.length > shownCharacters ? `${text.slice(0, shownCharacters)}\n[The rest is not shown.]` : text

/**
 * Run `script` (the body of an async function) in a fresh QuickJS VM with no network, no DOM and no app
 * state. The script reads its inputs with `readFile(name)` and hands files back with `saveFile(filename,
 * bytes)`; a saved file whose zip or XML would not open fails the run. Every failure, including each limit,
 * returns an error worded for the model to act on. `onReady` runs once the libraries are loaded, right before
 * the script starts, which is also when the script's time starts.
 */
export const runSandboxedScript = async (
  runtime: SandboxRuntime,
  { script, inputs }: SandboxJob,
  limits: SandboxLimits = sandboxLimits,
  onReady: () => void = () => {},
): Promise<SandboxResult> => {
  const inputBytes = new Map(inputs.map(({ name, bytes }) => [name, bytes]))
  const installWorkbooks = usesWorkbooks(script) ? await runtime.loadWorkbooks() : undefined
  // Loading the libraries is the app's own work, so it does not count against the script's time.
  let deadline = Infinity
  const encoder = new TextEncoder()
  const files: SavedFile[] = []
  let logs = ''
  let textBytes = 0
  let savedBytes = 0
  let stopped: string | null = null
  let finished: { error?: string } | null = null
  const formulaErrors: FileFormulaError[] = []
  // Files saved exactly as `WriteToBuffer` gave them, with the parts the check still parses: the rest is Excelize's.
  const fromExcelize = new Map<SavedFile, string[]>()
  let savedWorkbookOf: ReturnType<InstallWorkbooks> | undefined

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
    const define = (name: string, fn: (...args: JSValueHandle[]) => JSValueHandle | undefined) => {
      const handle = vm.newFunction(name, (...args) => fn(...args) ?? vm.undefined)
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
      // Converted before the count: on anything but a string, `toString()` runs guest code that can save files too.
      const name = filename.toString()
      if (files.length >= limits.maxFiles) {
        stopped ??= `The script saved more than ${limits.maxFiles} files and was stopped. One run can save at most ${limits.maxFiles}.`
        return
      }
      const copy = new Uint8Array(bytes.toArrayBuffer())
      savedBytes += name.length + copy.byteLength
      if (savedBytes > limits.memoryBytes) {
        stopped ??= `The script saved more than ${limits.memoryBytes / 1024 / 1024} MiB of files and was stopped. Build smaller files.`
        return
      }
      const file = { filename: name, bytes: copy }
      files.push(file)
      const workbook = savedWorkbookOf?.(copy)
      if (workbook) {
        fromExcelize.set(file, workbook.copiedParts)
        formulaErrors.push(...workbook.formulaErrors.map((error) => ({ file: name, ...error })))
      }
    })
    // A fresh copy per call, made inside the VM, so its memory limit counts it. The VM takes its own reference to
    // a returned handle, so each call releases the previous one, or every copy would live until the run ends.
    let lastRead: JSValueHandle | undefined
    define('__readFile', (name) => {
      const bytes = inputBytes.get(name.toString())
      lastRead?.dispose()
      lastRead = bytes && vm.newUint8Array(bytes)
      return lastRead
    })
    define('__finish', (error) => {
      finished = error ? { error: error.toString() } : {}
    })

    vm.evalCode(prelude, 'prelude.js').dispose()
    runtime.libraries.forEach((code, index) => vm.evalCode(code, `library-${index}.js`).dispose())
    vm.evalCode(runtime.ooxmlLibrary, 'ooxml.js').dispose()
    savedWorkbookOf = installWorkbooks?.(vm, limits, (reason) => {
      stopped ??= reason
    })
    deadline = performance.now() + limits.timeoutMs
    onReady()
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
  // Checked only after the script's VM is gone, so the two never hold memory at the same time.
  const error = stopped ?? finished?.error ?? (await findBrokenFile(runtime, files, limits, deadline, fromExcelize))
  if (error === undefined) {
    const listed = formulaErrors.length > 0 ? formulaErrors.slice(0, maxFormulaErrors) : undefined
    return { ok: true, files, logs: shownLogs, formulaErrors: listed }
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
