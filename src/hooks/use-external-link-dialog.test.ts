import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { useExternalLinkDialog } from './use-external-link-dialog'

describe('useExternalLinkDialog', () => {
  describe('initial state', () => {
    it('should initialize with dialog closed and empty URL', () => {
      const { result } = renderHook(() => useExternalLinkDialog())

      expect(result.current.dialogOpen).toBe(false)
      expect(result.current.pendingUrl).toBe('')
    })
  })

  describe('openDialog', () => {
    it('should set pending URL and open dialog', () => {
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://example.com')
      })

      expect(result.current.dialogOpen).toBe(true)
      expect(result.current.pendingUrl).toBe('https://example.com')
    })

    it('should handle multiple different URLs', () => {
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://first.com')
      })

      expect(result.current.pendingUrl).toBe('https://first.com')

      act(() => {
        result.current.openDialog('https://second.com')
      })

      expect(result.current.pendingUrl).toBe('https://second.com')
    })
  })

  describe('handleConfirm', () => {
    it('should open URL in new window and close dialog', () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => null)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://example.com')
      })

      act(() => {
        result.current.handleConfirm()
      })

      expect(mockWindowOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
      expect(result.current.dialogOpen).toBe(false)
      expect(result.current.pendingUrl).toBe('')

      window.open = originalOpen
    })

    it('should not open window when pendingUrl is empty', () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => null)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.handleConfirm()
      })

      expect(mockWindowOpen).not.toHaveBeenCalled()
      expect(result.current.dialogOpen).toBe(false)

      window.open = originalOpen
    })
  })

  describe('setDialogOpen', () => {
    it('should allow manually closing the dialog', () => {
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://example.com')
      })

      expect(result.current.dialogOpen).toBe(true)

      act(() => {
        result.current.setDialogOpen(false)
      })

      expect(result.current.dialogOpen).toBe(false)
      // pendingUrl should still be set (only cleared on confirm)
      expect(result.current.pendingUrl).toBe('https://example.com')
    })

    it('should allow manually opening the dialog', () => {
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.setDialogOpen(true)
      })

      expect(result.current.dialogOpen).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('should handle URLs with special characters', () => {
      const { result } = renderHook(() => useExternalLinkDialog())
      const specialUrl = 'https://example.com/path?foo=bar&baz=qux#fragment'

      act(() => {
        result.current.openDialog(specialUrl)
      })

      expect(result.current.pendingUrl).toBe(specialUrl)
    })

    it('should handle very long URLs', () => {
      const { result } = renderHook(() => useExternalLinkDialog())
      const longUrl = 'https://example.com/' + 'a'.repeat(1000)

      act(() => {
        result.current.openDialog(longUrl)
      })

      expect(result.current.pendingUrl).toBe(longUrl)
    })

    it('should handle empty string URL', () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => null)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('')
      })

      act(() => {
        result.current.handleConfirm()
      })

      // Should not call window.open for empty URL
      expect(mockWindowOpen).not.toHaveBeenCalled()

      window.open = originalOpen
    })
  })
})
