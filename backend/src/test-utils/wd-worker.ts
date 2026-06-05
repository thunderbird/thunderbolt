/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* DIAGNOSTIC (ci-hang-watchdog): a watchdog worker that detects a
 * synchronously-blocked main thread during `bun test`. It runs on its own
 * thread, so it keeps reporting even when the main thread is frozen and Bun's
 * per-test timeout can no longer fire. */

// `self` is the worker global (provided by bun-types); cast for `onmessage`.
;(self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage = (e: MessageEvent) => {
  const [sab1, sab2] = e.data as [SharedArrayBuffer, SharedArrayBuffer]
  const hb = new Int32Array(sab1) // [0]=heartbeat [1]=testInFlight [2]=testIdx [3]=dbDepth
  const sqlLen = new Int32Array(sab2, 0, 1)
  const sqlBytes = new Uint8Array(sab2)
  const dec = new TextDecoder()

  let last = -1
  let lastChange = Date.now()

  const readSql = () => {
    const len = Atomics.load(sqlLen, 0)
    if (len <= 0) {
      return '(no query in flight)'
    }
    return dec.decode(sqlBytes.subarray(4, 4 + Math.min(len, 240)))
  }

  setInterval(() => {
    const cur = Atomics.load(hb, 0)
    const now = Date.now()
    if (cur !== last) {
      last = cur
      lastChange = now
      return
    }
    const stall = now - lastChange
    const inFlight = Atomics.load(hb, 1)
    const dbDepth = Atomics.load(hb, 3)
    if (stall > 12000 && (inFlight === 1 || dbDepth > 0)) {
      const idx = Atomics.load(hb, 2)
      process.stderr.write(
        `[WD] *** MAIN THREAD BLOCKED *** test #${idx} stuck ~${Math.round(stall / 1000)}s ` +
          `(dbDepth=${dbDepth}, worker alive) last-query: ${readSql()}\n`,
      )
    }
  }, 2000)
}
