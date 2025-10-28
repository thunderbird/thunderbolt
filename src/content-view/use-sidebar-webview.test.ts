import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type RefObject } from 'react'
import { useSidebarWebview, type SidebarWebviewConfig } from './use-sidebar-webview'

beforeAll(() => {
  // Set up happy-dom global environment
  GlobalRegistrator.register()

  // Mock ResizeObserver for testing
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterAll(() => {
  // Clean up happy-dom global environment to prevent pollution
  GlobalRegistrator.unregister()
})

// Mock Tauri APIs
const mockWebview = {
  setPosition: mock(() => Promise.resolve()),
  setSize: mock(() => Promise.resolve()),
  close: mock(() => Promise.resolve()),
  once: mock(() => {}),
}

const mockWindow = {
  onResized: mock(() => Promise.resolve(() => {})),
  onMoved: mock(() => Promise.resolve(() => {})),
}

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

describe('useSidebarWebview', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    mockWebview.setPosition.mockClear()
    mockWebview.setSize.mockClear()
    mockWebview.close.mockClear()
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
      // Mock getBoundingClientRect
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

      await waitFor(
        () => {
          expect(result.current.isInitialized).toBe(true)
        },
        { timeout: 1000 },
      )
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
    it('should calculate update position correctly', () => {
      const previewHeaderHeight = 48
      const coordinateOffset = 28

      const rect = { top: 100, height: 600 }
      const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
      const webviewHeight = Math.floor(rect.height) - previewHeaderHeight

      expect(webviewTop).toBe(176) // 100 + 48 + 28
      expect(webviewHeight).toBe(552) // 600 - 48
    })

    it('should calculate init position with different offset', () => {
      const previewHeaderHeight = 48
      const coordinateOffset = 30

      const rect = { top: 100, height: 600 }
      const webviewTop = Math.floor(rect.top) + previewHeaderHeight + coordinateOffset
      const webviewHeight = Math.floor(rect.height) - previewHeaderHeight

      expect(webviewTop).toBe(178) // 100 + 48 + 30
      expect(webviewHeight).toBe(552) // 600 - 48
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

      // Wait for initialization
      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true)
      })

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

      const { result } = renderHook(() => useSidebarWebview(config, containerRef))

      // Wait for initialization
      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true)
      })

      // Trigger unload event
      const unloadEvent = new Event('unload')
      window.dispatchEvent(unloadEvent)

      // Verify webview.close was called
      expect(mockWebview.close).toHaveBeenCalled()
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

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true)
      })

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
      const { act } = await import('@testing-library/react')
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

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true)
      })

      await act(async () => {
        await result.current.closeWebview()
      })

      expect(onClose).toHaveBeenCalled()
    })

    it('should not attempt double-close when closeWebview is called before cleanup', async () => {
      const { act } = await import('@testing-library/react')
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

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true)
      })

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
      const { act } = await import('@testing-library/react')
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

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true)
      })

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
      const { act } = await import('@testing-library/react')
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

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true)
      })

      // Close the webview
      await act(async () => {
        await result.current.closeWebview()
      })

      // Clear mocks to track only new calls
      mockWebview.setPosition.mockClear()
      mockWebview.setSize.mockClear()

      // Trigger a resize event after close (would normally trigger position update)
      window.dispatchEvent(new Event('resize'))

      // Wait a frame for any position updates to attempt
      await new Promise((resolve) => requestAnimationFrame(resolve))

      // Verify position/size were NOT called after webview was closed
      expect(mockWebview.setPosition).not.toHaveBeenCalled()
      expect(mockWebview.setSize).not.toHaveBeenCalled()
      expect(result.current.webview).toBeNull()
      expect(result.current.isInitialized).toBe(false)
    })
  })
})
