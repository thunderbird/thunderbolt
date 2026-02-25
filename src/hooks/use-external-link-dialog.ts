import { useCallback, useRef, useState } from 'react'
import { isTauri } from '@/lib/platform'
import { isSafeUrl } from '@/lib/url-utils'

type UseExternalLinkDialogReturn = {
  dialogOpen: boolean
  pendingUrl: string
  openDialog: (url: string) => void
  handleConfirm: () => Promise<void>
  setDialogOpen: (open: boolean) => void
}

/**
 * Hook for managing external link warning dialog state.
 * Encapsulates the common pattern of showing a confirmation dialog
 * before opening external links in a new window.
 * Callbacks are stable (useCallback) so context consumers (e.g. SafeLink)
 * do not re-render when the provider re-renders during streaming.
 */
export const useExternalLinkDialog = (): UseExternalLinkDialogReturn => {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string>('')
  const pendingUrlRef = useRef<string>('')

  const openDialog = useCallback((url: string) => {
    pendingUrlRef.current = url
    setPendingUrl(url)
    setDialogOpen(true)
  }, [])

  const handleConfirm = useCallback(async () => {
    const urlToOpen = pendingUrlRef.current

    // Early return for empty URL
    if (!urlToOpen) {
      setDialogOpen(false)
      return
    }

    // Defense-in-depth: Validate URL even though callers should validate
    if (!isSafeUrl(urlToOpen)) {
      console.error('Attempted to open unsafe URL:', urlToOpen)
      setDialogOpen(false)
      setPendingUrl('')
      pendingUrlRef.current = ''
      return
    }

    // Close dialog immediately (starts fade-out animation)
    setDialogOpen(false)

    try {
      if (isTauri()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener')
        await openUrl(urlToOpen)
      } else {
        window.open(urlToOpen, '_blank', 'noopener,noreferrer')
      }
    } catch (error) {
      console.error('Failed to open URL:', error)
      // Fallback to window.open for graceful degradation
      window.open(urlToOpen, '_blank', 'noopener,noreferrer')
    }
    // Don't clear pendingUrl here — next openDialog overwrites it; leaving it
    // set avoids flicker during dialog close and removes timer/race entirely.
  }, [])

  return {
    dialogOpen,
    pendingUrl,
    openDialog,
    handleConfirm,
    setDialogOpen,
  }
}
