/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type JSValueHandle, QuickJS } from 'quickjs-wasi'
import type { SandboxLimits } from './constants'
import type { SandboxRuntime, SavedFile } from './sandbox'

// A DOM in QuickJS takes several times the memory of its XML; a 1,000-page document.xml is about 3.5 MB.
const checkMemoryFactor = 4

/*
 * Runs in the check VM, which holds only the zip and XML libraries. Each file comes in through `__savedFile`, and
 * each XML part is inflated and parsed on its own, so only one part and its DOM are alive at a time. The parser
 * stops on warnings too: by default it accepts an undefined entity and an unquoted attribute, which Office does not.
 * A memory or stack error means the check itself ran out of room, so it is rethrown to the host, which reports the
 * file as too large to check. An entry that understates its size inflates to no more than that size, but decoding
 * the rest still takes time, which the deadline bounds.
 */
const checker = (maxXmlBytes: number) => `(() => {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const isXmlPart = (name) => /\\.(xml|rels)$/i.test(name)
  const reason = (error) => {
    const text = error instanceof Error ? error.message : String(error)
    // The parser wraps what is thrown while it parses, so a memory error can arrive inside a parse error.
    if (error instanceof InternalError || /out of memory|stack overflow/i.test(text)) throw error
    return text.replace(/\\s+/g, ' ').trim()
  }
  globalThis.__check = (index) => {
    const bytes = __savedFile(index)
    const names = []
    let declared = 0
    try {
      fflate.unzipSync(bytes, {
        filter: ({ name, originalSize }) => {
          if (isXmlPart(name)) {
            names.push(name)
            declared += originalSize
          }
          return false
        },
      })
    } catch (error) {
      return { reason: reason(error) }
    }
    if (declared > ${maxXmlBytes}) {
      return { reason: 'its XML parts unzip to more than ${maxXmlBytes / 1024 / 1024} MiB' }
    }
    for (const name of names) {
      let data
      try {
        data = fflate.unzipSync(bytes, { filter: (file) => file.name === name })[name]
      } catch (error) {
        return { reason: reason(error) }
      }
      try {
        new xmldom.DOMParser({ onError: xmldom.onWarningStopParsing }).parseFromString(decoder.decode(data), 'text/xml')
      } catch (error) {
        return { part: name, reason: reason(error) }
      }
    }
  }
})()`

const describeProblem = (filename: string, problem: JSValueHandle) => {
  const part = problem.getProp('part').consume((handle) => (handle.isUndefined ? undefined : handle.toString()))
  const reason = problem.getProp('reason').consume((handle) => handle.toString())
  return part === undefined
    ? `"${filename}" does not open as a zip (${reason}), so Word and PowerPoint cannot open it. Save the bytes from Packer.toArrayBuffer, pres.write or fflate.zipSync as they are.`
    : `"${filename}" would not open: its part ${part} is not valid XML (${reason}). Escape &, <, > and " in text and in attribute values such as font names, then call the tool again.`
}

/**
 * Why Word or PowerPoint would refuse one of the saved files, worded for the model, or `undefined` when every
 * file's zip opens and every XML part parses. The files are the model's own bytes, so they are checked in a fresh
 * VM with its own memory limit and the script's deadline, never on the Worker's heap.
 */
export const findBrokenFile = async (
  runtime: SandboxRuntime,
  files: SavedFile[],
  limits: SandboxLimits,
  deadline: number,
): Promise<string | undefined> => {
  if (files.length === 0) {
    return undefined
  }
  const memoryLimit = checkMemoryFactor * limits.memoryBytes
  // As in the script VM, loading the libraries is the app's own work and is not cut short.
  let loaded = false
  const vm = await QuickJS.create({
    wasm: runtime.wasm,
    extensions: runtime.extensions,
    memoryLimit,
    interruptHandler: () => loaded && performance.now() > deadline,
  })
  try {
    // The VM keeps its own reference to a returned handle, so each file's copy is released before the next.
    let current: JSValueHandle | undefined
    const savedFile = vm.newFunction('__savedFile', (index) => {
      current?.dispose()
      current = vm.newUint8Array(files[index.toNumber()].bytes)
      return current
    })
    vm.setProp(vm.global, '__savedFile', savedFile)
    savedFile.dispose()
    vm.evalCode(runtime.ooxmlLibrary, 'ooxml.js').dispose()
    vm.evalCode(checker(memoryLimit), 'check.js').dispose()
    loaded = true
    for (const [index, { filename }] of files.entries()) {
      try {
        const problem = vm
          .evalCode(`__check(${index})`)
          .consume((result) => (result.isUndefined ? undefined : describeProblem(filename, result)))
        if (problem !== undefined) {
          return problem
        }
      } catch (error) {
        if (!/out of memory|interrupted|stack overflow/i.test(String(error))) {
          throw error
        }
        return `The XML in "${filename}" is too large to check. Make the file smaller or split it into several files, then call the tool again.`
      }
    }
    return undefined
  } finally {
    vm.dispose()
  }
}
