import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const mockCheckApprovalAndUnwrap = mock(() => Promise.resolve(false))
const mockUseHttpClient = mock(() => 'mock-http-client')

mock.module('@/services/encryption', () => ({
  checkApprovalAndUnwrap: mockCheckApprovalAndUnwrap,
}))

mock.module('@/contexts', () => ({
  useHttpClient: mockUseHttpClient,
}))

import { useApprovalPolling } from './use-approval-polling'

describe('useApprovalPolling', () => {
  beforeEach(() => {
    mockCheckApprovalAndUnwrap.mockClear()
    mockCheckApprovalAndUnwrap.mockImplementation(() => Promise.resolve(false))
  })

  afterEach(() => {
    cleanup()
    mockCheckApprovalAndUnwrap.mockRestore?.()
  })

  it('does not poll when disabled', async () => {
    const onApproved = mock(() => {})
    renderHook(() => useApprovalPolling({ enabled: false, onApproved, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(mockCheckApprovalAndUnwrap).not.toHaveBeenCalled()
  })

  it('returns isPolling=false when disabled', () => {
    const onApproved = mock(() => {})
    const { result } = renderHook(() => useApprovalPolling({ enabled: false, onApproved }))

    expect(result.current.isPolling).toBe(false)
  })

  it('returns isPolling=true when enabled', () => {
    const onApproved = mock(() => {})
    const { result } = renderHook(() => useApprovalPolling({ enabled: true, onApproved, intervalMs: 5000 }))

    expect(result.current.isPolling).toBe(true)
  })

  it('polls and calls onApproved when approved', async () => {
    mockCheckApprovalAndUnwrap.mockImplementation(() => Promise.resolve(true))
    const onApproved = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, onApproved, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(60)
    })
    expect(mockCheckApprovalAndUnwrap).toHaveBeenCalled()
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('continues polling silently on errors then succeeds', async () => {
    let callCount = 0
    mockCheckApprovalAndUnwrap.mockImplementation(() => {
      callCount++
      if (callCount <= 2) {
        return Promise.reject(new Error('Network error'))
      }
      return Promise.resolve(true)
    })
    const onApproved = mock(() => {})

    renderHook(() => useApprovalPolling({ enabled: true, onApproved, intervalMs: 50 }))

    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(onApproved).toHaveBeenCalledTimes(1)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it('stops polling on unmount', async () => {
    const onApproved = mock(() => {})
    const { unmount } = renderHook(() => useApprovalPolling({ enabled: true, onApproved, intervalMs: 50 }))

    unmount()
    const callsBefore = mockCheckApprovalAndUnwrap.mock.calls.length

    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(mockCheckApprovalAndUnwrap.mock.calls.length).toBe(callsBefore)
  })

  it('stops polling when enabled changes to false', async () => {
    const onApproved = mock(() => {})
    const { rerender } = renderHook(({ enabled }) => useApprovalPolling({ enabled, onApproved, intervalMs: 50 }), {
      initialProps: { enabled: true },
    })

    await act(async () => {
      await getClock().tickAsync(60)
    })

    rerender({ enabled: false })

    const callsBefore = mockCheckApprovalAndUnwrap.mock.calls.length
    await act(async () => {
      await getClock().tickAsync(200)
    })
    expect(mockCheckApprovalAndUnwrap.mock.calls.length).toBe(callsBefore)
  })
})
