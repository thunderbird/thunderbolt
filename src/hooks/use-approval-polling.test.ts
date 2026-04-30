/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { HttpError } from '@/lib/http'
import { useApprovalPolling } from './use-approval-polling'

const createHTTPError = (status: number) => new HttpError(new Response(null, { status }))

describe('useApprovalPolling', () => {
  afterEach(() => {
    cleanup()
  })

  it('does not poll when disabled', async () => {
    const checkApproval = mock(() => Promise.resolve(false))
    const onApproved = mock(() => {})
    renderHook(() => useApprovalPolling({ enabled: false, checkApproval, onApproved, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(checkApproval).not.toHaveBeenCalled()
  })

  it('returns isPolling=false when disabled', () => {
    const checkApproval = mock(() => Promise.resolve(false))
    const onApproved = mock(() => {})
    const { result } = renderHook(() => useApprovalPolling({ enabled: false, checkApproval, onApproved }))

    expect(result.current.isPolling).toBe(false)
  })

  it('returns isPolling=true when enabled', () => {
    const checkApproval = mock(() => Promise.resolve(false))
    const onApproved = mock(() => {})
    const { result } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, intervalMs: 5000 }),
    )

    expect(result.current.isPolling).toBe(true)
  })

  it('polls and calls onApproved when approved', async () => {
    const checkApproval = mock(() => Promise.resolve(true))
    const onApproved = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, checkApproval, onApproved, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(checkApproval).toHaveBeenCalled()
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('continues polling silently on errors then succeeds', async () => {
    let callCount = 0
    const checkApproval = mock(() => {
      callCount++
      if (callCount <= 2) {
        return Promise.reject(new Error('Network error'))
      }
      return Promise.resolve(true)
    })
    const onApproved = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, checkApproval, onApproved, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(onApproved).toHaveBeenCalledTimes(1)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it('stops polling on unmount', async () => {
    const checkApproval = mock(() => Promise.resolve(false))
    const onApproved = mock(() => {})
    const { unmount } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, intervalMs: 50 }),
    )

    unmount()
    const callsBefore = checkApproval.mock.calls.length

    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(checkApproval.mock.calls.length).toBe(callsBefore)
  })

  it('stops polling when enabled changes to false', async () => {
    const checkApproval = mock(() => Promise.resolve(false))
    const onApproved = mock(() => {})
    const { rerender } = renderHook(
      ({ enabled }) => useApprovalPolling({ enabled, checkApproval, onApproved, intervalMs: 50 }),
      { initialProps: { enabled: true } },
    )

    await act(async () => {
      await getClock().tickAsync(60)
    })

    rerender({ enabled: false })

    const callsBefore = checkApproval.mock.calls.length
    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(checkApproval.mock.calls.length).toBe(callsBefore)
  })

  it('calls onRevoked and stops polling on 403 error', async () => {
    const error403 = createHTTPError(403)
    const checkApproval = mock(() => Promise.reject(error403))
    const onApproved = mock(() => {})
    const onRevoked = mock(() => {})

    const { result } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, onRevoked, intervalMs: 50 }),
    )

    await act(async () => {
      await getClock().tickAsync(60)
    })

    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(onApproved).not.toHaveBeenCalled()
    expect(result.current.isPolling).toBe(false)

    // Verify polling stopped
    const callsBefore = checkApproval.mock.calls.length
    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(checkApproval.mock.calls.length).toBe(callsBefore)
  })

  it('continues polling on non-403 errors but stops on 403', async () => {
    let callCount = 0
    const checkApproval = mock(() => {
      callCount++
      if (callCount <= 2) {
        return Promise.reject(new Error('Network error'))
      }
      return Promise.reject(createHTTPError(403))
    })
    const onApproved = mock(() => {})
    const onRevoked = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, checkApproval, onApproved, onRevoked, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(200)
    })

    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(onApproved).not.toHaveBeenCalled()
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it('does not call onRevoked after cleanup even if 403 arrives', async () => {
    let rejectCheck: (reason: Error) => void
    const checkApproval = mock(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectCheck = reject
        }),
    )
    const onApproved = mock(() => {})
    const onRevoked = mock(() => {})

    const { unmount } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, onRevoked, intervalMs: 50 }),
    )

    await act(async () => {
      await getClock().tickAsync(60)
    })

    unmount()

    await act(async () => {
      rejectCheck!(createHTTPError(403))
    })

    expect(onRevoked).not.toHaveBeenCalled()
  })

  it('does not call onApproved after cleanup even if check resolves', async () => {
    let resolveCheck: (value: boolean) => void
    const checkApproval = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const onApproved = mock(() => {})

    const { unmount } = renderHook(() =>
      useApprovalPolling({ enabled: true, checkApproval, onApproved, intervalMs: 50 }),
    )

    // Trigger the first check
    await act(async () => {
      await getClock().tickAsync(60)
    })

    // Unmount while check is in-flight
    unmount()

    // Resolve the in-flight check with approved=true
    await act(async () => {
      resolveCheck!(true)
    })

    expect(onApproved).not.toHaveBeenCalled()
  })
})
