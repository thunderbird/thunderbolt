/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useDeferredVisibility } from './use-deferred-visibility'

describe('useDeferredVisibility', () => {
  it('stays inactive until the delay elapses, then activates for a visible element', async () => {
    // A null ref skips the observer, leaving `visible` at its optimistic default,
    // so this isolates the delay gate.
    const ref = { current: null }
    const { result } = renderHook(() => useDeferredVisibility(ref, 2000))

    expect(result.current).toBe(false)

    await act(async () => {
      await getClock().tickAsync(1999)
    })
    expect(result.current).toBe(false)

    await act(async () => {
      await getClock().tickAsync(1)
    })
    expect(result.current).toBe(true)
  })
})
