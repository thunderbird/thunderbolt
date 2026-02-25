import { useCallback, useRef, useState } from 'react'
import { isTauri } from '@/lib/platform'
import { isSafeUrl } from '@/lib/url-utils'

const OPEN_FAILED_MESSAGE = 'Could not open link. Please try again or copy the URL.'

type UseExternalLinkDialogReturn = {
  dialogOpen: boolean
  pendingUrl: string
  openDialog: (url: string) => void
  handleConfirm: () => Promise<void>
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
      if (isTauri()) {
        setOpenError(OPEN_FAILED_MESSAGE)
      } else {
        const fallback = window.open(urlToOpen, '_blank', 'noopener,noreferrer')
        if (fallback === null) {
          setOpenError(OPEN_FAILED_MESSAGE)
        } else {
          setDialogOpen(false)
        }
      }
    } finally {
      setIsOpening(false)
    }
  }, [])

  return {
    dialogOpen,
    pendingUrl,
    openDialog,
    handleConfirm,
    setDialogOpen,
    openError,
    isOpening,
  }
}
