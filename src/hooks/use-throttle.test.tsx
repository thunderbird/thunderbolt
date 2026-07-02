/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { renderHook, act } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { useThrottledCallback } from './use-throttle'

describe('useThrottledCallback', () => {
  it('should call callback immediately on first invocation', () => {
    const callback = mock((..._args: any[]) => {})
    const { result } = renderHook(() => useThrottledCallback(callback, 1000))

    act(() => {
      result.current('test')
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('test')
  })

  it('should throttle rapid calls', async () => {
    const callback = mock((..._args: any[]) => {})
    const { result } = renderHook(() => useThrottledCallback(callback, 100))

    // First call - immediate
    act(() => {
      result.current('first')
    })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('first')

    // Rapid calls - throttled
    act(() => {
      result.current('second')
      result.current('third')
      result.current('fourth')
    })

    // Should still only have been called once (first call)
    expect(callback).toHaveBeenCalledTimes(1)

    // Wait for throttle to complete
    await act(async () => {
      await getClock().tickAsync(150)
    })

    // Should have been called with the last value
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1]?.[0]).toBe('fourth')
  })

  it('should allow calls after interval passes', async () => {
    const callback = mock((..._args: any[]) => {})
    const { result } = renderHook(() => useThrottledCallback(callback, 50))

    act(() => {
      result.current('first')
    })
    expect(callback).toHaveBeenCalledTimes(1)

    // Wait for interval to pass
    await act(async () => {
      await getClock().tickAsync(60)
    })

    // Next call should be immediate
    act(() => {
      result.current('second')
    })
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1]?.[0]).toBe('second')
  })

  it('should handle multiple arguments', () => {
    const callback = mock((..._args: any[]) => {})
    const { result } = renderHook(() => useThrottledCallback(callback, 1000))

    act(() => {
      result.current('arg1', 'arg2', 'arg3')
    })

    expect(callback).toHaveBeenCalledWith('arg1', 'arg2', 'arg3')
  })

  it('should drop the pending trailing call when cancelled', async () => {
    const callback = mock((..._args: string[]) => {})
    const { result } = renderHook(() => useThrottledCallback(callback, 100))

    act(() => {
      result.current('first') // immediate
      result.current('second') // schedules trailing
    })
    expect(callback).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.cancel()
    })

    await act(async () => {
      await getClock().tickAsync(150)
    })

    // Trailing call never fired.
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('should flush the pending trailing call immediately with the latest args', async () => {
    const callback = mock((..._args: string[]) => {})
    const { result } = renderHook(() => useThrottledCallback(callback, 100))

    act(() => {
      result.current('first') // immediate
      result.current('second') // schedules trailing
      result.current('third') // reschedules trailing with latest args
    })
    expect(callback).toHaveBeenCalledTimes(1)

    // Flush runs the pending call NOW, before the throttle window elapses.
    act(() => {
      result.current.flush()
    })
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1]?.[0]).toBe('third')

    // The drained timer must not fire a second trailing call.
    await act(async () => {
      await getClock().tickAsync(150)
    })
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('should be a no-op to flush when nothing is pending', async () => {
    const callback = mock((..._args: string[]) => {})
    const { result } = renderHook(() => useThrottledCallback(callback, 100))

    // Nothing scheduled yet.
    act(() => {
      result.current.flush()
    })
    expect(callback).not.toHaveBeenCalled()

    // A single leading-edge call leaves no trailing timer, so flush stays a no-op.
    act(() => {
      result.current('only') // immediate, no trailing pending
      result.current.flush()
    })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('only')

    await act(async () => {
      await getClock().tickAsync(150)
    })
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
