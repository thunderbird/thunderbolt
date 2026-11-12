/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createContext, Script, type Context } from 'node:vm'

const browserRuntime = new Script(
  new Bun.Transpiler({ loader: 'ts' }).transformSync(
    readFileSync(new URL('./install-process.ts', import.meta.url), 'utf8'),
  ),
)
const goRuntime = new Script(
  readFileSync(new URL('../../../node_modules/privatemode-ai/dist/wasm_exec.js', import.meta.url), 'utf8'),
)

type BrowserProcess = {
  browser: boolean
  env: Record<string, string | undefined>
  versions: Record<string, string | undefined>
  getuid?: () => number
  cwd: () => string
  on: () => BrowserProcess
  nextTick: (callback: () => void) => void
}

/** Evaluate each import order in a browser-like realm without altering the test runner's process. */
const browserContext = () => createContext({ crypto, performance, TextEncoder, TextDecoder, queueMicrotask })
/** Read only the process surface exercised by the browser compatibility contract. */
const installedProcess = (context: Context): BrowserProcess => context.process as BrowserProcess

describe('browser process installation', () => {
  test('completes the actual Go runtime process while preserving its identity and methods', async () => {
    const context = browserContext()
    goRuntime.runInContext(context)
    const original = installedProcess(context)
    const originalCwd = original.cwd
    const originalGetuid = original.getuid
    expect(original.env).toBeUndefined()

    browserRuntime.runInContext(context)
    const runtimeProcess = installedProcess(context)
    expect(runtimeProcess).toBe(original)
    expect(runtimeProcess.cwd).toBe(originalCwd)
    expect(runtimeProcess.getuid).toBe(originalGetuid)
    expect(runtimeProcess.getuid?.()).toBe(-1)
    expect(runtimeProcess.cwd).toThrow('not implemented')
    expect(runtimeProcess.env).toEqual({})
    expect(runtimeProcess.versions).toEqual({})
    expect(runtimeProcess.browser).toBe(true)
    expect(runtimeProcess.on()).toBe(runtimeProcess)

    const events: string[] = []
    runtimeProcess.nextTick(() => events.push('tick'))
    expect(events).toEqual([])
    await Promise.resolve()
    expect(events).toEqual(['tick'])
  })

  test('retains the browser process when Go loads afterward', () => {
    const context = browserContext()
    browserRuntime.runInContext(context)
    const original = installedProcess(context)
    goRuntime.runInContext(context)

    expect(installedProcess(context)).toBe(original)
    expect(original.env).toEqual({})
    expect(original.versions).toEqual({})
    expect(original.cwd()).toBe('/')
    expect(original.on()).toBe(original)
    expect(typeof context.Go).toBe('function')
  })

  test.each(['node', 'bun'])('leaves a native %s process unchanged', (runtime) => {
    const nativeProcess = Object.freeze({ versions: { [runtime]: '1.0.0' }, env: { PRESERVED: 'value' } })
    const context = createContext({ process: nativeProcess })
    browserRuntime.runInContext(context)
    expect(context.process).toBe(nativeProcess)
    expect(Object.keys(context.process)).toEqual(['versions', 'env'])
    expect(context.process.env).toEqual({ PRESERVED: 'value' })
  })

  test('does not alter the running Bun process', () => {
    const before = Object.getOwnPropertyDescriptors(process)
    const context = createContext({ process })
    browserRuntime.runInContext(context)
    expect(context.process).toBe(process)
    expect(Object.getOwnPropertyDescriptors(process)).toEqual(before)
  })
})
