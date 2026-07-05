/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useThrottledValue } from './use-throttled-value'

describe('useThrottledValue', () => {
  it('shows the first value immediately then settles on the latest once per interval', async () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 100), { initialProps: { v: 'a' } })
    expect(result.current).toBe('a')

    rerender({ v: 'b' })
    rerender({ v: 'c' })
    expect(result.current).toBe('a') // throttled — not flushed yet

    await act(async () => {
      await getClock().tickAsync(100)
    })
    expect(result.current).toBe('c') // settled on the latest value
  })
})
