import { useCallback, useState } from 'react'

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

  const openDialog = useCallback((url: string) => {
    setPendingUrl(url)
    setDialogOpen(true)
  }, [])

  const handleConfirm = useCallback(() => {
    setDialogOpen(false)
    setPendingUrl((current) => {
      if (current) {
        window.open(current, '_blank', 'noopener,noreferrer')
      }
      return ''
    })
  }, [])

  return {
    dialogOpen,
    pendingUrl,
    openDialog,
    handleConfirm,
    setDialogOpen,
  }
}
