/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { clearAllKeys, generateAK, storeAK, storeDEK } from '@/crypto'
import { act, cleanup, renderHook } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { dispatchE2eeProvisioningSettled, useE2eeReady } from './use-e2ee-ready'

/**
 * Drive the hook's async read to completion, then assert.
 *
 * Two harness facts make the obvious spellings wrong here. `waitFor` routes
 * through the `asyncWrapper` configured in `src/testing-library.ts` and lands
 * on testing-library's fake-timer path, which throws. And a bare
 * `await new Promise(r => setTimeout(r, 1))` never resolves, because that file
 * installs a GLOBAL fake clock — real timers do not fire until it is ticked.
 * So: tick the clock inside `act`, exactly as `waitForElement` does.
 */
const settle = async (reads: () => boolean): Promise<void> => {
  const clock = getClock()
  for (let attempt = 0; attempt < 20; attempt++) {
    await act(async () => {
      clock.tick(10)
      await clock.runAllAsync()
    })
    if (reads()) {
      return
    }
  }
  throw new Error('useE2eeReady never reached the expected value')
}

/** What the seamless migration writes: an AK plus the initial wrapped DEK. */
const provision = async () => {
  await storeAK(await generateAK())
  await storeDEK('0', 'd3JhcHBlZA==')
}

describe('useE2eeReady', () => {
  beforeEach(async () => {
    await clearAllKeys()
  })

  afterEach(cleanup)

  it('reports false while the device holds no keys', async () => {
    const { result } = renderHook(() => useE2eeReady())
    await settle(() => result.current === false)
    expect(result.current).toBe(false)
  })

  it('reports true once the key hierarchy is complete', async () => {
    await provision()
    const { result } = renderHook(() => useE2eeReady())
    await settle(() => result.current === true)
    expect(result.current).toBe(true)
  })

  it('re-reads when provisioning settles, instead of latching the mounted value', async () => {
    // THE regression. The seamless v1→v2 migration runs fire-and-forget from
    // init while the app is usable, so a settings page can mount before the
    // keys land. The old one-shot effect latched `false` forever: the
    // change-phrase section stayed hidden and `useLockoutPending` never
    // enabled its query, so a revoked device whose rotation failed was never
    // offered "Finish securing".
    const { result } = renderHook(() => useE2eeReady())
    await settle(() => result.current === false)

    await provision()
    act(() => dispatchE2eeProvisioningSettled())

    await settle(() => result.current === true)
    expect(result.current).toBe(true)
  })
})
