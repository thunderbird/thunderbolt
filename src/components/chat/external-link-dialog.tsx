import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ExternalLink, PanelRight, X } from 'lucide-react'
import { memo, useCallback } from 'react'

type ExternalLinkDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  url: string
  onConfirm: () => Promise<void>
  /** Called when onConfirm() rejects (e.g. unhandled throw). Use to show error in dialog. */
  onOpenError?: (error: unknown) => void
  onOpenInApp?: () => void
  openError?: string | null
  isOpening?: boolean
}

export const ExternalLinkDialog = memo(
  ({
    open,
    onOpenChange,
    url,
    onConfirm,
    onOpenError,
    onOpenInApp,
    openError = null,
    isOpening = false,
  }: ExternalLinkDialogProps) => {
    const handleConfirmClick = useCallback(async () => {
      try {
        await onConfirm()
      } catch (error) {
        if (onOpenError) {
          onOpenError(error)
        } else {
          console.error('External link confirm failed:', error)
        }
      }
    }, [onConfirm, onOpenError])

    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open external link</AlertDialogTitle>
            <AlertDialogDescription className="sr-only">Confirm opening an external link</AlertDialogDescription>
            <button
              onClick={() => onOpenChange(false)}
              className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </button>
          </AlertDialogHeader>

          <div className="rounded-md border bg-muted px-4 py-3 text-sm font-mono break-all max-h-32 overflow-y-auto">
            {url}
          </div>

          {openError && <p className="text-sm text-destructive">{openError}</p>}

          <AlertDialogFooter>
            {onOpenInApp && (
              <Button onClick={onOpenInApp} variant="outline" disabled={isOpening}>
                <PanelRight className="size-4" />
                Open in Sidebar
              </Button>
            )}
            <Button onClick={handleConfirmClick} disabled={isOpening}>
              {onOpenInApp && <ExternalLink className="size-4" />}
              {isOpening ? 'Opening…' : onOpenInApp ? 'Open in Browser' : 'Open link'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  },
)

ExternalLinkDialog.displayName = 'ExternalLinkDialog'
