import { useCallback, useRef, useState } from 'react'
import { isTauri } from '@/lib/platform'

type UseExternalLinkDialogReturn = {
  dialogOpen: boolean
  pendingUrl: string
  openDialog: (url: string) => void
  handleConfirm: () => void
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
    setDialogOpen(false)
    setPendingUrl('')
    pendingUrlRef.current = ''
    if (urlToOpen) {
      if (isTauri()) {
        // In Tauri, use shell.open to open URLs in system browser
        const { open } = await import('@tauri-apps/plugin-shell')
        await open(urlToOpen)
      } else {
        window.open(urlToOpen, '_blank', 'noopener,noreferrer')
      }
    }
  }, [])

  return {
    dialogOpen,
    pendingUrl,
    openDialog,
    handleConfirm,
    setDialogOpen,
  }
}
