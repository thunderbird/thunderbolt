import { useState } from 'react'

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
 */
export const useExternalLinkDialog = (): UseExternalLinkDialogReturn => {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string>('')

  const openDialog = (url: string) => {
    setPendingUrl(url)
    setDialogOpen(true)
  }

  const handleConfirm = () => {
    if (pendingUrl) {
      window.open(pendingUrl, '_blank', 'noopener,noreferrer')
    }
    setDialogOpen(false)
    setPendingUrl('')
  }

  return {
    dialogOpen,
    pendingUrl,
    openDialog,
    handleConfirm,
    setDialogOpen,
  }
}
