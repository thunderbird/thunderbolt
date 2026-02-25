import { useCallback, useRef, useState } from 'react'
import { isTauri } from '@/lib/platform'
import { isSafeUrl } from '@/lib/url-utils'

const OPEN_FAILED_MESSAGE = 'Could not open link. Please try again or copy the URL.'

type UseExternalLinkDialogReturn = {
  dialogOpen: boolean
  pendingUrl: string
  openDialog: (url: string) => void
  handleConfirm: () => Promise<void>
  /** Call when confirm promise rejects (e.g. unhandled throw) to show error in dialog. */
  reportOpenError: () => void
  dismissWithAction: (action: (url: string) => void) => void
  setDialogOpen: (open: boolean) => void
  openError: string | null
  isOpening: boolean
}

/**
 * Hook for managing external link warning dialog state.
 * Encapsulates the common pattern of showing a confirmation dialog
 * before opening external links in a new window.
 * Dialog closes only after a successful open; on failure (e.g. Tauri/openUrl
 * or window.open fails) the dialog stays open and openError is set.
 * Callbacks are stable (useCallback) so context consumers (e.g. SafeLink)
 * do not re-render when the provider re-renders during streaming.
 */
export const useExternalLinkDialog = (): UseExternalLinkDialogReturn => {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string>('')
  const [openError, setOpenError] = useState<string | null>(null)
  const [isOpening, setIsOpening] = useState(false)
  const pendingUrlRef = useRef<string>('')

  const openDialog = useCallback((url: string) => {
    pendingUrlRef.current = url
    setPendingUrl(url)
    setOpenError(null)
    setDialogOpen(true)
  }, [])

  const handleConfirm = useCallback(async () => {
    const urlToOpen = pendingUrlRef.current

    if (!urlToOpen) {
      setDialogOpen(false)
      return
    }

    if (!isSafeUrl(urlToOpen)) {
      console.error('Attempted to open unsafe URL:', urlToOpen)
      setDialogOpen(false)
      setPendingUrl('')
      pendingUrlRef.current = ''
      return
    }

    setIsOpening(true)
    setOpenError(null)

    try {
      if (isTauri()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener')
        await openUrl(urlToOpen)
      } else {
        const opened = window.open(urlToOpen, '_blank', 'noopener,noreferrer')
        if (opened === null) {
          setOpenError(OPEN_FAILED_MESSAGE)
          return
        }
      }
      setDialogOpen(false)
    } catch (error) {
      console.error('Failed to open URL:', error)
      setOpenError(OPEN_FAILED_MESSAGE)
    } finally {
      setIsOpening(false)
    }
  }, [])

  const reportOpenError = useCallback(() => {
    setOpenError(OPEN_FAILED_MESSAGE)
  }, [])

  /** Closes the dialog and invokes `action` with the pending URL. Validates URL with isSafeUrl before invoking (defense-in-depth with handleConfirm). */
  const dismissWithAction = useCallback((action: (url: string) => void) => {
    const url = pendingUrlRef.current
    if (!url) return
    if (!isSafeUrl(url)) {
      console.error('Attempted to open unsafe URL in app:', url)
      setOpenError(OPEN_FAILED_MESSAGE)
      setDialogOpen(false)
      setPendingUrl('')
      pendingUrlRef.current = ''
      return
    }
    setDialogOpen(false)
    action(url)
  }, [])

  return {
    dialogOpen,
    pendingUrl,
    openDialog,
    handleConfirm,
    reportOpenError,
    dismissWithAction,
    setDialogOpen,
    openError,
    isOpening,
  }
}
