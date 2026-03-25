import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useApprovalPolling } from './use-approval-polling'

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
