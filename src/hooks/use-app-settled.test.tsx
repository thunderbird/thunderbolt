/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'bun:test'
import { resetAppSettledForTests, useAppSettled } from './use-app-settled'

describe('useAppSettled', () => {
  beforeEach(() => {
    resetAppSettledForTests()
  })

  it('starts unsettled and settles once after the delay', async () => {
    const { result } = renderHook(() => useAppSettled())
    expect(result.current).toBe(false)

    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(result.current).toBe(true)
  })

  it('is already settled for a consumer mounted afterwards — no re-delay', async () => {
    const first = renderHook(() => useAppSettled())
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(first.result.current).toBe(true)

    // e.g. the inline card re-mounting after the side panel closes — runs immediately.
    const second = renderHook(() => useAppSettled())
    expect(second.result.current).toBe(true)
  })
})
