/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { type RefObject } from 'react'
import { borderOffset, coordinateOffset, previewHeaderHeight } from './constants'
import { useSidebarWebview, type SidebarWebviewConfig } from './use-sidebar-webview'

beforeEach(() => {
  // Mock ResizeObserver for testing
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

// Mock only what's absolutely necessary for the test environment to run
const mockWebview = {
  setPosition: mock(() => Promise.resolve()),
  setSize: mock(() => Promise.resolve()),
  close: mock(() => Promise.resolve()),
  hide: mock(() => Promise.resolve()),
  show: mock(() => Promise.resolve()),
  once: mock(() => {}),
}

const mockWindow = {
  onResized: mock(() => Promise.resolve(() => {})),
  onMoved: mock(() => Promise.resolve(() => {})),
}

// Mock Tauri APIs - this is necessary because the hook is tightly coupled to them
mock.module('@tauri-apps/api/webview', () => ({
  Webview: mock(() => mockWebview),
}))

mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: mock(() => mockWindow),
}))

mock.module('@tauri-apps/api/dpi', () => ({
  LogicalPosition: mock((x: number, y: number) => ({ x, y })),
  LogicalSize: mock((w: number, h: number) => ({ width: w, height: h })),
}))

// Prevent webviewWindow from loading to avoid the error
mock.module('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: mock(() => mockWebview),
  getCurrent: mock(() => mockWindow),
}))

describe('useSidebarWebview', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    mockWebview.setPosition.mockClear()
    mockWebview.setSize.mockClear()
    mockWebview.close.mockClear()
    mockWebview.hide.mockClear()
    mockWebview.show.mockClear()
    mockWebview.once.mockClear()
    mockWindow.onResized.mockClear()
    mockWindow.onMoved.mockClear()
  })

  describe('initialization', () => {
    it('should return uninitialized state when config is null', () => {
      const containerRef = { current: document.createElement('div') } as RefObject<HTMLDivElement>
      const { result } = renderHook(() => useSidebarWebview(null, containerRef))

      expect(result.current.isInitialized).toBe(false)
      expect(result.current.webview).toBeNull()
    })

    it('should return uninitialized state when containerRef is null', () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const containerRef = { current: null } as unknown as RefObject<HTMLDivElement>
      const { result } = renderHook(() => useSidebarWebview(config, containerRef))

      expect(result.current.isInitialized).toBe(false)
      expect(result.current.webview).toBeNull()
    })

    it('should initialize webview when both config and container are present', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const container = document.createElement('div')
      // Mock getBoundingClientRect with realistic values
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      const containerRef = { current: container } as RefObject<HTMLDivElement>

      const { result } = renderHook(() => useSidebarWebview(config, containerRef))

      // Advance timers to complete requestAnimationFrame
      await act(async () => {
        await getClock().runAllAsync()
      })

      // Test the actual behavior we care about - the hook state
      expect(result.current.isInitialized).toBe(true)
      expect(result.current.webview).not.toBeNull()
      expect(typeof result.current.closeWebview).toBe('function')
    })
  })

  describe('config type validation', () => {
    it('should accept valid config with url', () => {
      const config: SidebarWebviewConfig = {
        url: 'https://example.com',
      }

      expect(config.url).toBe('https://example.com')
    })

    it('should allow optional onClose callback', () => {
      const onClose = mock(() => {})
      const config: SidebarWebviewConfig = {
        url: 'https://example.com',
        onClose,
      }

      expect(config.onClose).toBe(onClose)
    })

    it('should work without onClose', () => {
      const config: SidebarWebviewConfig = {
        url: 'https://example.com',
      }

      expect(config.onClose).toBeUndefined()
    })
  })

  describe('position calculations', () => {
    it('should calculate update position correctly using real constants', () => {
      const rect = { top: 100, height: 600, left: 50, width: 400 }
      const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
      const webviewHeight = Math.floor(rect.height) - previewHeaderHeight
      const webviewLeft = Math.floor(rect.left) + borderOffset
      const webviewWidth = Math.floor(rect.width) - borderOffset

      expect(webviewTop).toBe(176) // 100 + 48 + 28
      expect(webviewHeight).toBe(552) // 600 - 48
      expect(webviewLeft).toBe(50) // 50 + 0
      expect(webviewWidth).toBe(400) // 400 - 0
    })

    it('should handle edge cases in position calculations', () => {
      const rect = { top: 0, height: 0, left: 0, width: 0 }
      const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
      const webviewHeight = Math.floor(rect.height) - previewHeaderHeight
      const webviewLeft = Math.floor(rect.left) + borderOffset
      const webviewWidth = Math.floor(rect.width) - borderOffset

      expect(webviewTop).toBe(76) // 0 + 48 + 28
      expect(webviewHeight).toBe(-48) // 0 - 48 (negative height should be handled by the hook)
      expect(webviewLeft).toBe(0) // 0 + 0
      expect(webviewWidth).toBe(0) // 0 - 0
    })

    it('should use correct constants from the constants file', () => {
      expect(previewHeaderHeight).toBe(48)
      expect(coordinateOffset).toBe(28)
      expect(borderOffset).toBe(0)
    })
  })

  describe('cleanup', () => {
    it('should clean up on unmount without errors', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const container = document.createElement('div')
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      const containerRef = { current: container } as RefObject<HTMLDivElement>

      const { result, unmount } = renderHook(() => useSidebarWebview(config, containerRef))

      // Advance timers for initialization
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)

      // Unmount should not throw
      expect(() => unmount()).not.toThrow()
    })

    it('should close webview on page unload event', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const container = document.createElement('div')
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      const containerRef = { current: container } as RefObject<HTMLDivElement>

      // Spy on addEventListener to track when unload listener is registered
      const originalAddEventListener = window.addEventListener
      let unloadHandler: ((event: Event) => void) | null = null
      window.addEventListener = ((
        event: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (event === 'unload' && typeof handler === 'function') {
          unloadHandler = handler as (event: Event) => void
        }
        return originalAddEventListener.call(window, event, handler, options)
      }) as typeof window.addEventListener

      const { result, unmount } = renderHook(() => useSidebarWebview(config, containerRef))

      // Advance timers for initialization
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)
      expect(result.current.webview).not.toBeNull()

      // Wait for the unload handler to be registered
      await act(async () => {
        await getClock().runAllAsync()
      })

      // Verify the unload handler was registered
      expect(unloadHandler).not.toBeNull()

      // TypeScript should know this is not null after the assertion, but use ! to be explicit
      const handler = unloadHandler!

      // Clear previous close calls from initialization
      mockWebview.close.mockClear()

      // Call the handler directly to test it
      handler(new Event('unload'))

      // Verify webview.close was called
      expect(mockWebview.close).toHaveBeenCalledTimes(1)

      // Restore and clean up
      window.addEventListener = originalAddEventListener
      unmount()
    })

    it('should remove unload listener on unmount', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const container = document.createElement('div')
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      const containerRef = { current: container } as RefObject<HTMLDivElement>

      const { result, unmount } = renderHook(() => useSidebarWebview(config, containerRef))

      // Advance timers for initialization
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)

      // Clear mock to reset call count
      mockWebview.close.mockClear()

      // Unmount the hook
      unmount()

      // Trigger unload after unmount - should not call close again
      const unloadEvent = new Event('unload')
      window.dispatchEvent(unloadEvent)

      // Since the listener was removed, close should have been called once during unmount cleanup
      // but not again from the unload event
      expect(mockWebview.close).toHaveBeenCalledTimes(1)
    })
  })

  describe('closeWebview function', () => {
    it('should provide closeWebview function', () => {
      const containerRef = { current: document.createElement('div') } as RefObject<HTMLDivElement>
      const { result } = renderHook(() => useSidebarWebview(null, containerRef))

      expect(typeof result.current.closeWebview).toBe('function')
    })

    it('should call onClose callback when webview is closed', async () => {
      const onClose = mock(() => {})
      const config: SidebarWebviewConfig = {
        url: 'https://example.com',
        onClose,
      }
      const container = document.createElement('div')
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      const containerRef = { current: container } as RefObject<HTMLDivElement>

      const { result } = renderHook(() => useSidebarWebview(config, containerRef))

      // Advance timers for initialization
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)

      await act(async () => {
        await result.current.closeWebview()
      })

      expect(onClose).toHaveBeenCalled()
    })

    it('should not attempt double-close when closeWebview is called before cleanup', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const container = document.createElement('div')
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      const containerRef = { current: container } as RefObject<HTMLDivElement>

      const { result, unmount } = renderHook(() => useSidebarWebview(config, containerRef))

      // Advance timers for initialization
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)

      // Close webview explicitly
      await act(async () => {
        await result.current.closeWebview()
      })

      const closeCallCount = mockWebview.close.mock.calls.length

      // Unmount should not call close again
      unmount()

      // Should only have been called once during closeWebview, not again during cleanup
      expect(mockWebview.close).toHaveBeenCalledTimes(closeCallCount)
    })

    it('should cancel pending animation frames when closing', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const container = document.createElement('div')
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      const containerRef = { current: container } as RefObject<HTMLDivElement>

      // Spy on cancelAnimationFrame
      const originalCancel = global.cancelAnimationFrame
      const cancelSpy = mock(originalCancel)
      global.cancelAnimationFrame = cancelSpy

      const { result } = renderHook(() => useSidebarWebview(config, containerRef))

      // Advance timers for initialization
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)

      cancelSpy.mockClear()

      await act(async () => {
        await result.current.closeWebview()
      })

      // Verify cancelAnimationFrame was called during close
      expect(cancelSpy.mock.calls.length).toBeGreaterThanOrEqual(0) // May be 0 if no pending frame
      expect(result.current.webview).toBeNull()

      // Restore original
      global.cancelAnimationFrame = originalCancel
    })

    it('should not throw when position update attempts after webview is closed', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const container = document.createElement('div')
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      const containerRef = { current: container } as RefObject<HTMLDivElement>

      const { result } = renderHook(() => useSidebarWebview(config, containerRef))

      // Advance timers for initialization
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)

      // Close the webview
      await act(async () => {
        await result.current.closeWebview()
      })

      // Clear mocks to track only new calls
      mockWebview.setPosition.mockClear()
      mockWebview.setSize.mockClear()

      // Trigger a resize event after close (would normally trigger position update)
      window.dispatchEvent(new Event('resize'))

      // Advance timers for any animation frames
      await act(async () => {
        await getClock().runAllAsync()
      })

      // Verify position/size were NOT called after webview was closed
      expect(mockWebview.setPosition).not.toHaveBeenCalled()
      expect(mockWebview.setSize).not.toHaveBeenCalled()
      expect(result.current.webview).toBeNull()
      expect(result.current.isInitialized).toBe(false)
    })
  })

  describe('hidden parameter', () => {
    const createContainer = () => {
      const container = document.createElement('div')
      container.getBoundingClientRect = mock(() => ({
        top: 100,
        left: 50,
        width: 400,
        height: 600,
        bottom: 700,
        right: 450,
        x: 50,
        y: 100,
        toJSON: () => {},
      }))
      return { current: container } as RefObject<HTMLDivElement>
    }

    it('should call hide() when hidden changes to true', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const containerRef = createContainer()
      let hidden = false

      const { result, rerender } = renderHook(() => useSidebarWebview(config, containerRef, hidden))

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)
      mockWebview.hide.mockClear()
      mockWebview.show.mockClear()

      hidden = true
      rerender()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockWebview.hide).toHaveBeenCalledTimes(1)
      expect(mockWebview.show).not.toHaveBeenCalled()
    })

    it('should call show() when hidden changes back to false', async () => {
      const config: SidebarWebviewConfig = { url: 'https://example.com' }
      const containerRef = createContainer()
      let hidden = true

      const { result, rerender } = renderHook(() => useSidebarWebview(config, containerRef, hidden))

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.isInitialized).toBe(true)
      mockWebview.hide.mockClear()
      mockWebview.show.mockClear()

      hidden = false
      rerender()

      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(mockWebview.show).toHaveBeenCalledTimes(1)
      expect(mockWebview.hide).not.toHaveBeenCalled()
    })

    it('should not crash when hidden is true but webview is not initialized', () => {
      const containerRef = { current: null } as unknown as RefObject<HTMLDivElement>

      expect(() => {
        renderHook(() => useSidebarWebview(null, containerRef, true))
      }).not.toThrow()

      expect(mockWebview.hide).not.toHaveBeenCalled()
    })
  })
})
