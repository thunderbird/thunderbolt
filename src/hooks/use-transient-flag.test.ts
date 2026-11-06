/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useTransientFlag } from './use-transient-flag'

describe('useTransientFlag', () => {
  it('starts unset', () => {
    const { result } = renderHook(() => useTransientFlag())
    expect(result.current.isSet).toBe(false)
  })

  it('sets on demand', () => {
    const { result } = renderHook(() => useTransientFlag())
    act(() => result.current.flag())
    expect(result.current.isSet).toBe(true)
  })

  /*
   * The bug this exists for: the artifact download button set its flag and never
   * cleared it, so the tick stayed for the life of the component and a second
   * download gave no feedback at all.
   */
  it('falls back on its own', async () => {
    const { result } = renderHook(() => useTransientFlag(2000))
    act(() => result.current.flag())
    await act(async () => {
      await getClock().tickAsync(2000)
    })

    expect(result.current.isSet).toBe(false)
  })

  it('stays set until the window elapses', async () => {
    const { result } = renderHook(() => useTransientFlag(2000))
    act(() => result.current.flag())
    await act(async () => {
      await getClock().tickAsync(1900)
    })

    expect(result.current.isSet).toBe(true)
  })

  /** Retriggering restarts the window rather than stacking timers. */
  it('extends the window when flagged again', async () => {
    const { result } = renderHook(() => useTransientFlag(2000))
    act(() => result.current.flag())
    await act(async () => {
      await getClock().tickAsync(1500)
    })
    act(() => result.current.flag())
    await act(async () => {
      await getClock().tickAsync(1500)
    })

    expect(result.current.isSet).toBe(true)
  })

  /** A late fire must not set state on a component that has gone. */
  it('clears its timer on unmount', async () => {
    const { result, unmount } = renderHook(() => useTransientFlag(2000))
    act(() => result.current.flag())
    unmount()

    await act(async () => {
      await getClock().tickAsync(2000)
    })
  })
})
