import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { useHaptics } from './use-haptics'

const originalMatchMedia = window.matchMedia

describe('useHaptics', () => {
  beforeEach(() => {
    window.matchMedia = () =>
      ({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('returns isAvailable false when navigator.vibrate is absent', () => {
    const nav = navigator as unknown as { vibrate?: (pattern: number | number[]) => boolean }
    const vibrate = nav.vibrate
    nav.vibrate = undefined

    const { result } = renderHook(() => useHaptics())
    expect(result.current.isAvailable).toBe(false)

    nav.vibrate = vibrate
  })

  it('does not throw when triggerSelection is called when unavailable', () => {
    const nav = navigator as unknown as { vibrate?: (pattern: number | number[]) => boolean }
    const vibrate = nav.vibrate
    nav.vibrate = undefined

    const { result } = renderHook(() => useHaptics())
    expect(() => result.current.triggerSelection()).not.toThrow()

    nav.vibrate = vibrate
  })
})
