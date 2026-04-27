/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { useExternalLinkDialog } from './use-external-link-dialog'

describe('useExternalLinkDialog', () => {
  describe('initial state', () => {
    it('should initialize with dialog closed, empty URL, no error, not opening', () => {
      const { result } = renderHook(() => useExternalLinkDialog())

      expect(result.current.dialogOpen).toBe(false)
      expect(result.current.pendingUrl).toBe('')
      expect(result.current.openError).toBe(null)
      expect(result.current.isOpening).toBe(false)
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

    it('should handle multiple different URLs and clear openError', () => {
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://first.com')
      })

      expect(result.current.pendingUrl).toBe('https://first.com')

      act(() => {
        result.current.openDialog('https://second.com')
      })

      expect(result.current.pendingUrl).toBe('https://second.com')
      expect(result.current.openError).toBe(null)
    })
  })

  describe('handleConfirm', () => {
    it('should open URL in new window and close dialog on success', async () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://example.com')
      })

      await act(async () => {
        await result.current.handleConfirm()
      })

      expect(mockWindowOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
      expect(result.current.dialogOpen).toBe(false)
      expect(result.current.pendingUrl).toBe('https://example.com')

      window.open = originalOpen
    })

    it('should close dialog even when window.open returns null (noopener returns null on success)', async () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => null)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://example.com')
      })

      await act(async () => {
        await result.current.handleConfirm()
      })

      expect(mockWindowOpen).toHaveBeenCalled()
      expect(result.current.dialogOpen).toBe(false)
      expect(result.current.openError).toBeNull()

      window.open = originalOpen
    })

    it('should not open window when pendingUrl is empty', async () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      await act(async () => {
        await result.current.handleConfirm()
      })

      expect(mockWindowOpen).not.toHaveBeenCalled()
      expect(result.current.dialogOpen).toBe(false)

      window.open = originalOpen
    })

    it('should keep dialog open and set openError when URL is unsafe (same UX as dismissWithAction)', async () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('javascript:alert(1)')
      })
      await act(async () => {
        await result.current.handleConfirm()
      })

      expect(mockWindowOpen).not.toHaveBeenCalled()
      expect(result.current.dialogOpen).toBe(true)
      expect(result.current.pendingUrl).toBe('javascript:alert(1)')
      expect(result.current.openError).toBe('Could not open link. Please try again or copy the URL.')

      window.open = originalOpen
    })
  })

  describe('dismissWithAction', () => {
    it('should invoke action with URL when URL is safe', () => {
      const action = mock(() => {})
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://example.com')
      })
      act(() => {
        result.current.dismissWithAction(action)
      })

      expect(action).toHaveBeenCalledTimes(1)
      expect(action).toHaveBeenCalledWith('https://example.com')
      expect(result.current.dialogOpen).toBe(false)
    })

    it('should not invoke action, keep dialog open and set openError when URL is unsafe', () => {
      const action = mock(() => {})
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('javascript:alert(1)')
      })
      act(() => {
        result.current.dismissWithAction(action)
      })

      expect(action).not.toHaveBeenCalled()
      expect(result.current.dialogOpen).toBe(true)
      expect(result.current.pendingUrl).toBe('javascript:alert(1)')
      expect(result.current.openError).toBe('Could not open link. Please try again or copy the URL.')
    })

    it('should do nothing when pendingUrl is empty', () => {
      const action = mock(() => {})
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.dismissWithAction(action)
      })

      expect(action).not.toHaveBeenCalled()
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

    it('should handle empty string URL', async () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('')
      })

      await act(async () => {
        await result.current.handleConfirm()
      })

      expect(mockWindowOpen).not.toHaveBeenCalled()

      window.open = originalOpen
    })

    it('should open second URL when user confirms first then quickly opens another link', async () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://first.com')
      })
      await act(async () => {
        await result.current.handleConfirm()
      })
      act(() => {
        result.current.openDialog('https://second.com')
      })
      await act(async () => {
        await result.current.handleConfirm()
      })

      expect(mockWindowOpen).toHaveBeenCalledTimes(2)
      expect(mockWindowOpen).toHaveBeenLastCalledWith('https://second.com', '_blank', 'noopener,noreferrer')

      window.open = originalOpen
    })
  })
})
