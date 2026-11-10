/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { openFailedMessage, unsafeUrlMessage, useExternalLinkDialog } from './use-external-link-dialog'

describe('useExternalLinkDialog', () => {
  describe('remembered destination', () => {
    const originalOpen = window.open
    beforeEach(() => {
      useLocalSettingsStore.getState().setLocalSetting('externalLinkBehavior', 'ask')
      window.open = mock(() => null) as typeof window.open
    })
    afterEach(() => {
      useLocalSettingsStore.getState().setLocalSetting('externalLinkBehavior', 'ask')
      window.open = originalOpen
    })

    it('updates the existing preference to sidebar only after a checked in-app choice', () => {
      const { result } = renderHook(() => useExternalLinkDialog())
      act(() => {
        result.current.openDialog('https://example.com')
        result.current.setRememberChoice(true)
      })
      expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('ask')
      act(() => result.current.dismissWithAction(() => {}))
      expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('sidebar')
      expect(result.current.rememberChoice).toBe(false)
    })

    it('updates the existing preference to browser after a checked external choice succeeds', async () => {
      const { result } = renderHook(() => useExternalLinkDialog())
      act(() => {
        result.current.openDialog('https://example.com')
        result.current.setRememberChoice(true)
      })
      await act(async () => result.current.handleConfirm())
      expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('browser')
      expect(result.current.dialogOpen).toBe(false)
    })

    it('leaves the preference unchanged for unchecked choices', async () => {
      const { result } = renderHook(() => useExternalLinkDialog())
      act(() => result.current.openDialog('https://example.com'))
      await act(async () => result.current.handleConfirm())
      act(() => {
        result.current.openDialog('https://example.com')
        result.current.dismissWithAction(() => {})
      })
      expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('ask')
    })

    it('does not save when canceled and resets the checkbox on the next opening', () => {
      const { result } = renderHook(() => useExternalLinkDialog())
      act(() => {
        result.current.openDialog('https://example.com')
        result.current.setRememberChoice(true)
        result.current.setDialogOpen(false)
        result.current.openDialog('https://example.com')
      })
      expect(result.current.rememberChoice).toBe(false)
      expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('ask')
    })

    it('does not save or close a reopened dialog when a canceled open finishes', async () => {
      const { result } = renderHook(() => useExternalLinkDialog())
      act(() => {
        result.current.openDialog('https://example.com')
        result.current.setRememberChoice(true)
      })
      await act(async () => {
        const opening = result.current.handleConfirm()
        result.current.setDialogOpen(false)
        result.current.openDialog('https://example.com')
        await opening
      })
      expect(result.current.dialogOpen).toBe(true)
      expect(result.current.rememberChoice).toBe(false)
      expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('ask')
    })

    it('does not remember an unsafe destination', async () => {
      const { result } = renderHook(() => useExternalLinkDialog())
      act(() => {
        result.current.openDialog('javascript:alert(1)')
        result.current.setRememberChoice(true)
        result.current.dismissWithAction(() => {})
      })
      await act(async () => result.current.handleConfirm())
      expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('ask')
      expect(result.current.openError).toBe(unsafeUrlMessage)
    })

    it('keeps Ask when the selected opener fails', async () => {
      window.open = mock(() => {
        throw new Error('open failed')
      }) as typeof window.open
      const { result } = renderHook(() => useExternalLinkDialog())
      act(() => {
        result.current.openDialog('https://example.com')
        result.current.setRememberChoice(true)
      })
      await act(async () => result.current.handleConfirm())
      expect(useLocalSettingsStore.getState().externalLinkBehavior).toBe('ask')
      expect(result.current.dialogOpen).toBe(true)
      expect(result.current.rememberChoice).toBe(true)
    })
  })

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

    it('should seed openError when opened with one, and clear it when reopened without', () => {
      const { result } = renderHook(() => useExternalLinkDialog())

      act(() => {
        result.current.openDialog('https://example.com', openFailedMessage)
      })

      expect(result.current.dialogOpen).toBe(true)
      expect(result.current.openError).toBe(openFailedMessage)

      act(() => {
        result.current.openDialog('https://example.com')
      })

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
      expect(result.current.openError).toBe(unsafeUrlMessage)

      window.open = originalOpen
    })
  })

  describe('openExternally (the `browser` preference — no confirmation)', () => {
    it('should open the URL immediately without showing the dialog', async () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      await act(async () => {
        await result.current.openExternally('https://example.com')
      })

      expect(mockWindowOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
      expect(result.current.dialogOpen).toBe(false)
      expect(result.current.openError).toBeNull()

      window.open = originalOpen
    })

    it('should not open an unsafe URL, and should surface the dialog explaining why', async () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      await act(async () => {
        await result.current.openExternally('javascript:alert(1)')
      })

      expect(mockWindowOpen).not.toHaveBeenCalled()
      expect(result.current.dialogOpen).toBe(true)
      expect(result.current.pendingUrl).toBe('javascript:alert(1)')
      expect(result.current.openError).toBe(unsafeUrlMessage)

      window.open = originalOpen
    })

    it('should fall back to the dialog with an error when the opener throws', async () => {
      // Throwing is the only observable failure on web: noopener makes window.open
      // return null even on success, so the return value can't be used as a signal.
      const originalOpen = window.open
      window.open = mock(() => {
        throw new Error('popup blocked')
      }) as unknown as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      await act(async () => {
        await result.current.openExternally('https://example.com')
      })

      expect(result.current.dialogOpen).toBe(true)
      expect(result.current.pendingUrl).toBe('https://example.com')
      expect(result.current.openError).toBe(openFailedMessage)

      window.open = originalOpen
    })

    it('should let the user retry from the fallback dialog via handleConfirm', async () => {
      const originalOpen = window.open
      let shouldFail = true
      const mockWindowOpen = mock(() => {
        if (shouldFail) {
          throw new Error('popup blocked')
        }
        return {} as Window
      })
      window.open = mockWindowOpen as unknown as typeof window.open

      const { result } = renderHook(() => useExternalLinkDialog())

      await act(async () => {
        await result.current.openExternally('https://example.com')
      })

      expect(result.current.openError).toBe(openFailedMessage)

      shouldFail = false
      await act(async () => {
        await result.current.handleConfirm()
      })

      expect(result.current.dialogOpen).toBe(false)
      expect(result.current.openError).toBeNull()
      expect(mockWindowOpen).toHaveBeenLastCalledWith('https://example.com', '_blank', 'noopener,noreferrer')

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
      expect(result.current.openError).toBe(unsafeUrlMessage)
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
