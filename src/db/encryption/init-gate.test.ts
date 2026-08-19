/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'
import { beginEncryptionInit, endEncryptionInit, resetEncryptionInitGate, waitForEncryptionInit } from './init-gate'

/**
 * Drain the microtask queue so an already-settled await can run. Deliberately
 * not `setTimeout` — the gate's own timeout arm is a real timer, and a
 * macrotask flush would race it.
 */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

describe('encryption init gate', () => {
  beforeEach(() => {
    resetEncryptionInitGate()
  })

  it('resolves immediately when init never ran', async () => {
    expect(await waitForEncryptionInit()).toBe(true)
  })

  it('parks callers until the gate is released', async () => {
    beginEncryptionInit()
    let settled = false
    const waiter = waitForEncryptionInit().then((result) => {
      settled = true
      return result
    })

    await flush()
    expect(settled).toBe(false)

    endEncryptionInit()
    expect(await waiter).toBe(true)
  })

  it('releases every concurrent waiter', async () => {
    beginEncryptionInit()
    const waiters = Promise.all([waitForEncryptionInit(), waitForEncryptionInit(), waitForEncryptionInit()])

    endEncryptionInit()

    expect(await waiters).toEqual([true, true, true])
  })

  it('is idempotent — a second arm does not replace the pending gate', async () => {
    beginEncryptionInit()
    const waiter = waitForEncryptionInit()
    beginEncryptionInit()

    endEncryptionInit()

    expect(await waiter).toBe(true)
  })

  it('re-arms after release, so a second app init is gated too', async () => {
    beginEncryptionInit()
    endEncryptionInit()
    expect(await waitForEncryptionInit()).toBe(true)

    // `retry()` and `clearDatabase()` re-run app init. If releasing left the old
    // settled gate in place, this second arm would be a no-op and the waiter
    // below would resolve instantly while the migration is still running.
    beginEncryptionInit()
    let settled = false
    const waiter = waitForEncryptionInit().then(() => {
      settled = true
    })

    await flush()
    expect(settled).toBe(false)

    endEncryptionInit()
    await waiter
  })

  it('tolerates a release with no gate armed', () => {
    expect(() => endEncryptionInit()).not.toThrow()
  })
})
