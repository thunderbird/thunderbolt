/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* DIAGNOSTIC (ci-hang-watchdog): pinpoints the backend CI hard-hang. The hang is
 * a SYNCHRONOUS main-thread block (proven: it defeats Bun's 5s per-test timeout),
 * suspected to be a PGlite WASM query spinning on a wedged connection. This module
 * keeps a per-test + per-query heartbeat in a SharedArrayBuffer and runs an
 * out-of-thread Worker (wd-worker.ts) that, when the heartbeat freezes, reports
 * the stuck test index and the in-flight SQL — even though the main thread is dead.
 * Imported for side effects from test-setup.ts. Remove before merge. */

import { afterEach, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'

const sab1 = new SharedArrayBuffer(16)
const hb = new Int32Array(sab1) // [0]=heartbeat [1]=testInFlight [2]=testIdx [3]=dbDepth
const sab2 = new SharedArrayBuffer(256)
const sqlLen = new Int32Array(sab2, 0, 1)
const sqlBytes = new Uint8Array(sab2)
const enc = new TextEncoder()

const bump = () => Atomics.add(hb, 0, 1)

const setSql = (s: string) => {
  const bytes = enc.encode(s.replace(/\s+/g, ' ').trim())
  const n = Math.min(bytes.length, 240)
  sqlBytes.set(bytes.subarray(0, n), 4)
  Atomics.store(sqlLen, 0, n)
}

const worker = new Worker(new URL('./wd-worker.ts', import.meta.url))
worker.postMessage([sab1, sab2])
;(worker as { unref?: () => void }).unref?.()

let idx = 0
beforeEach(() => {
  idx += 1
  Atomics.store(hb, 2, idx)
  Atomics.store(hb, 1, 1)
  bump()
})
afterEach(() => {
  Atomics.store(hb, 1, 0)
  bump()
})

// Instrument PGlite so the worker can name the in-flight query when the main
// thread blocks inside the WASM. `function` (not arrow) is required to preserve
// the PGlite instance as `this`.
const proto = PGlite.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
for (const method of ['query', 'exec', 'transaction']) {
  const original = proto[method]
  if (typeof original !== 'function') {
    continue
  }
  proto[method] = function instrumented(this: unknown, ...args: unknown[]) {
    setSql(method === 'transaction' ? 'TRANSACTION()' : `[${method}] ${String(args[0] ?? '')}`)
    Atomics.add(hb, 3, 1)
    bump()
    const settle = () => {
      Atomics.sub(hb, 3, 1)
      bump()
    }
    let result: unknown
    try {
      result = original.apply(this, args)
    } catch (err) {
      settle()
      throw err
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as Promise<unknown>).finally(settle)
    }
    settle()
    return result
  }
}
