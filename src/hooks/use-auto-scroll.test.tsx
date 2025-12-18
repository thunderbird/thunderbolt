import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { useAutoScroll } from './use-auto-scroll'

describe('useAutoScroll', () => {
  afterEach(() => {
    cleanup()
  })

  const createMockContainer = (scrollTop = 0, scrollHeight = 1000, clientHeight = 500) => {
    let _scrollTop = scrollTop
    const div = document.createElement('div')
    Object.defineProperties(div, {
      scrollTop: {
        get: () => _scrollTop,
        set: (val) => {
          _scrollTop = val
        },
        configurable: true,
      },
      scrollHeight: { value: scrollHeight, configurable: true },
      clientHeight: { value: clientHeight, configurable: true },
    })
    return div
  }

  describe('initialization', () => {
    it('should return all required refs and handlers', () => {
      const { result } = renderHook(() => useAutoScroll())

      expect(result.current).toHaveProperty('scrollContainerRef')
      expect(result.current).toHaveProperty('scrollTargetRef')
      expect(result.current).toHaveProperty('userHasScrolled')
      expect(result.current).toHaveProperty('isAtBottom')
      expect(result.current).toHaveProperty('scrollToBottom')
      expect(result.current).toHaveProperty('resetUserScroll')
      expect(result.current).toHaveProperty('scrollHandlers')
    })

    it('should initialize with userHasScrolled as false', () => {
      const { result } = renderHook(() => useAutoScroll())

      expect(result.current.userHasScrolled).toBe(false)
    })

    it('should initialize with isAtBottom as true', () => {
      const { result } = renderHook(() => useAutoScroll())

      expect(result.current.isAtBottom).toBe(true)
    })

    it('should return scroll handlers with onScroll, onWheel, and onTouchStart', () => {
      const { result } = renderHook(() => useAutoScroll())

      expect(typeof result.current.scrollHandlers.onScroll).toBe('function')
      expect(typeof result.current.scrollHandlers.onWheel).toBe('function')
      expect(typeof result.current.scrollHandlers.onTouchStart).toBe('function')
    })
  })

  describe('scrollToBottom', () => {
    it('should scroll container to bottom with instant scroll', () => {
      const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

      const container = createMockContainer(0, 1000, 500)
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      act(() => {
        result.current.scrollToBottom(false) // instant scroll
      })

      expect(container.scrollTop).toBe(500) // scrollHeight - clientHeight
    })

    it('should use instant scroll when isStreaming is true', () => {
      const { result } = renderHook(() => useAutoScroll({ isStreaming: true }))

      const container = createMockContainer(0, 1000, 500)
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      act(() => {
        result.current.scrollToBottom()
      })

      // Instant scroll should set scrollTop immediately
      expect(container.scrollTop).toBe(500)
    })

    it('should not throw when scrollToBottom is called with smooth option', () => {
      const { result } = renderHook(() => useAutoScroll({ smooth: true, isStreaming: false }))

      const container = createMockContainer(0, 1000, 500)
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      // Verify smooth scroll can be called without throwing
      expect(() => {
        act(() => {
          result.current.scrollToBottom()
        })
      }).not.toThrow()
    })
  })

  describe('handleScroll', () => {
    it('should set userHasScrolled to true when scrolled far from bottom', () => {
      const { result } = renderHook(() => useAutoScroll())

      const container = createMockContainer(0, 1000, 500) // 500px from bottom (> 100px threshold)
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      act(() => {
        result.current.scrollHandlers.onScroll()
      })

      expect(result.current.userHasScrolled).toBe(true)
    })

    it('should set userHasScrolled to false when scrolled close to bottom', () => {
      const { result } = renderHook(() => useAutoScroll())

      // First scroll away
      const container = createMockContainer(0, 1000, 500)
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      act(() => {
        result.current.scrollHandlers.onScroll()
      })

      // Then scroll to bottom (scrollTop = scrollHeight - clientHeight - small offset)
      Object.defineProperty(container, 'scrollTop', { value: 480, configurable: true }) // 20px from bottom (< 50px threshold)

      act(() => {
        result.current.scrollHandlers.onScroll()
      })

      expect(result.current.userHasScrolled).toBe(false)
    })
  })

  describe('handleWheel', () => {
    it('should set userHasScrolled to true when scrolling up', () => {
      const { result } = renderHook(() => useAutoScroll())

      const container = createMockContainer(500, 1000, 500)
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      act(() => {
        result.current.scrollHandlers.onWheel({ deltaY: -100 } as React.WheelEvent)
      })

      expect(result.current.userHasScrolled).toBe(true)
    })

    it('should not change userHasScrolled when scrolling down', () => {
      const { result } = renderHook(() => useAutoScroll())

      act(() => {
        result.current.scrollHandlers.onWheel({ deltaY: 100 } as React.WheelEvent)
      })

      expect(result.current.userHasScrolled).toBe(false)
    })
  })

  describe('handleTouchStart', () => {
    it('should set userHasScrolled to true when not at bottom', () => {
      const { result } = renderHook(() => useAutoScroll())

      const container = createMockContainer(0, 1000, 500) // 500px from bottom
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      act(() => {
        result.current.scrollHandlers.onTouchStart({} as React.TouchEvent)
      })

      expect(result.current.userHasScrolled).toBe(true)
    })

    it('should not set userHasScrolled when at bottom', () => {
      const { result } = renderHook(() => useAutoScroll())

      const container = createMockContainer(500, 1000, 500) // at bottom
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      act(() => {
        result.current.scrollHandlers.onTouchStart({} as React.TouchEvent)
      })

      expect(result.current.userHasScrolled).toBe(false)
    })
  })

  describe('resetUserScroll', () => {
    it('should reset userHasScrolled to false', () => {
      const { result } = renderHook(() => useAutoScroll())

      // First set userHasScrolled to true
      const container = createMockContainer(0, 1000, 500)
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      act(() => {
        result.current.scrollHandlers.onScroll()
      })

      expect(result.current.userHasScrolled).toBe(true)

      // Then reset
      act(() => {
        result.current.resetUserScroll()
      })

      expect(result.current.userHasScrolled).toBe(false)
    })
  })

  describe('dependency-based scrolling', () => {
    it('should not scroll when user has scrolled away', () => {
      const { result, rerender } = renderHook(({ deps }) => useAutoScroll({ dependencies: deps, isStreaming: true }), {
        initialProps: { deps: ['a'] },
      })

      const container = createMockContainer(0, 1000, 500)
      ;(result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container

      // User scrolls away
      act(() => {
        result.current.scrollHandlers.onScroll()
      })

      expect(result.current.userHasScrolled).toBe(true)

      // Record current scrollTop
      const scrollTopBefore = container.scrollTop

      // Change dependencies
      act(() => {
        rerender({ deps: ['b'] })
      })

      // Should not have scrolled (scrollTop unchanged)
      expect(container.scrollTop).toBe(scrollTopBefore)
    })
  })
})
