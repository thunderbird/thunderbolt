/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import AbortControllerPolyfill, { AbortSignal as AbortSignalPolyfill } from 'abort-controller/dist/abort-controller.js'
import { installAbortSignalCompatibility } from './abort-signal-compat'

const abortControllerConstructor = AbortControllerPolyfill as unknown as typeof AbortController
const abortSignalConstructor = AbortSignalPolyfill as unknown as typeof AbortSignal & {
  abort?: (reason?: unknown) => AbortSignal
  any?: (signals: Iterable<AbortSignal>) => AbortSignal
  timeout?: (milliseconds: number) => AbortSignal
}

installAbortSignalCompatibility({
  AbortController: abortControllerConstructor,
  AbortSignal: abortSignalConstructor,
  setTimeout,
})

describe('AbortSignal compatibility', () => {
  it('composes signals and keeps the first abort reason', () => {
    const first = new abortControllerConstructor()
    const second = new abortControllerConstructor()
    const combined = abortSignalConstructor.any?.([first.signal, second.signal])
    const reason = new Error('cancelled')

    expect(combined).toBeDefined()
    first.abort(reason)
    second.abort(new Error('too late'))

    expect(combined?.aborted).toBe(true)
    expect(combined?.reason).toBe(reason)
  })

  it('preserves an already-aborted input reason', () => {
    const controller = new abortControllerConstructor()
    const reason = new Error('already cancelled')
    controller.abort(reason)

    const combined = abortSignalConstructor.any?.([controller.signal])

    expect(combined?.aborted).toBe(true)
    expect(combined?.reason).toBe(reason)
  })

  it('adds abort and timeout factories and throwIfAborted', () => {
    const reason = new Error('explicit')
    const aborted = abortSignalConstructor.abort?.(reason)
    expect(aborted?.reason).toBe(reason)
    expect(() => aborted?.throwIfAborted()).toThrow()
    expect(abortSignalConstructor.timeout).toBeFunction()
    expect(() => abortSignalConstructor.timeout?.(-1)).toThrow(RangeError)
  })
})
