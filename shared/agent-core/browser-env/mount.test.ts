/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the ZenFS mount glue. The only non-trivial behaviors are
 * `mountAgentFs`'s documented invariants: it must NEVER reject (an unusable OPFS
 * has to degrade to in-memory, not get the memoised promise stuck on a
 * rejection), and it must be memoised so repeated harness builds share one
 * global mount instead of reconfiguring the live singleton.
 *
 * We drive the OPFS-present-but-broken branch by installing a `navigator.storage`
 * whose `getDirectory` rejects (the realistic failure shape), assert the code
 * actually attempted OPFS, then assert the catch fell through to memory.
 *
 * Note: `agentFsMount` is module-scoped and memoised for the process lifetime, so
 * this file deliberately exercises `mountAgentFs` exactly once — a second
 * scenario would observe the cached promise, not a fresh evaluation.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import * as fsp from '@zenfs/core/promises'
import { mountAgentFs, mountInMemoryFs } from './mount.ts'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
})

describe('mountInMemoryFs', () => {
  it('mounts a usable in-memory filesystem at /', async () => {
    await mountInMemoryFs()
    await fsp.mkdir('/mounttest', { recursive: true })
    await fsp.writeFile('/mounttest/probe.txt', 'ok')
    expect((await fsp.readFile('/mounttest/probe.txt')).toString()).toBe('ok')
    await fsp.rm('/mounttest', { recursive: true, force: true })
  })
})

describe('mountAgentFs', () => {
  it('attempts OPFS, degrades to "memory" without rejecting when it fails, and memoises (in-flight + settled)', async () => {
    let getDirectoryCalls = 0
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          // Realistic failure shape: a rejected promise (private browsing / quota).
          getDirectory: () => {
            getDirectoryCalls += 1
            return Promise.reject(new Error('OPFS unavailable'))
          },
        },
      },
      configurable: true,
    })

    const first = mountAgentFs()
    const second = mountAgentFs()
    // In-flight memoisation: same promise, so getDirectory is attempted at most once.
    expect(first).toBe(second)

    expect(await first).toBe('memory')
    // The OPFS path was genuinely entered (isOpfsAvailable saw the function), then
    // the rejection was caught — proving fallback, not an unconditional skip.
    expect(getDirectoryCalls).toBe(1)

    // Settled memoisation: a post-resolution call reuses the cached promise too.
    const third = mountAgentFs()
    expect(third).toBe(first)
    expect(await third).toBe('memory')
    expect(getDirectoryCalls).toBe(1)

    // The fallback mount is usable.
    await fsp.writeFile('/agent-probe.txt', 'fallback')
    expect((await fsp.readFile('/agent-probe.txt')).toString()).toBe('fallback')
    await fsp.rm('/agent-probe.txt', { force: true })
  })
})
