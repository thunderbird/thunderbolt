import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useLongPress } from './use-long-press'

afterEach(() => {
  cleanup()
})

describe('useLongPress', () => {
  it('returns touch event handlers', () => {
    const onLongPress = mock(() => {})
    const { result } = renderHook(() => useLongPress({ onLongPress }))

    expect(result.current.onTouchStart).toBeFunction()
    expect(result.current.onTouchEnd).toBeFunction()
    expect(result.current.onTouchMove).toBeFunction()
  })

  it('calls onLongPress after default delay (500ms)', async () => {
    const onLongPress = mock(() => {})
    const { result } = renderHook(() => useLongPress({ onLongPress }))

    act(() => {
      result.current.onTouchStart()
    })

    expect(onLongPress).not.toHaveBeenCalled()

    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('calls onLongPress after custom delay', async () => {
    const onLongPress = mock(() => {})
    const { result } = renderHook(() => useLongPress({ onLongPress, delay: 300 }))

    act(() => {
      result.current.onTouchStart()
    })

    await act(async () => {
      await getClock().tickAsync(299)
    })

    expect(onLongPress).not.toHaveBeenCalled()

    await act(async () => {
      await getClock().tickAsync(1)
    })

    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('cancels on touchEnd before delay', async () => {
    const onLongPress = mock(() => {})
    const { result } = renderHook(() => useLongPress({ onLongPress }))

    act(() => {
      result.current.onTouchStart()
    })

    await act(async () => {
      await getClock().tickAsync(200)
    })

    act(() => {
      result.current.onTouchEnd()
    })

    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('cancels on touchMove (scroll)', async () => {
    const onLongPress = mock(() => {})
    const { result } = renderHook(() => useLongPress({ onLongPress }))

    act(() => {
      result.current.onTouchStart()
    })

    act(() => {
      result.current.onTouchMove()
    })

    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('does not fire after unmount', async () => {
    const onLongPress = mock(() => {})
    const { result, unmount } = renderHook(() => useLongPress({ onLongPress }))

    act(() => {
      result.current.onTouchStart()
    })

    unmount()

    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(onLongPress).not.toHaveBeenCalled()
  })
})
