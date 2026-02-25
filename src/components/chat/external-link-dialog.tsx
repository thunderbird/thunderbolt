import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
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
    const handleConfirmClick = useCallback(() => {
      Promise.resolve(onConfirm()).catch((error: unknown) => {
        if (onOpenError) onOpenError(error)
        else console.error('External link confirm failed:', error)
      })
    }, [onConfirm, onOpenError])

    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open external link</AlertDialogTitle>
            <AlertDialogDescription>You're leaving Thunderbolt to visit an external link:</AlertDialogDescription>
          </AlertDialogHeader>

          <div className="rounded-md border bg-muted px-4 py-3 text-sm font-mono break-all max-h-32 overflow-y-auto">
            {url}
          </div>

          {openError && <p className="text-sm text-destructive">{openError}</p>}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {onOpenInApp && (
              <Button onClick={onOpenInApp} variant="outline">
                Open in Thunderbolt
              </Button>
            )}
            <Button onClick={handleConfirmClick} disabled={isOpening}>
              {isOpening ? 'Opening…' : onOpenInApp ? 'Open in Browser' : 'Open link'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  },
)

ExternalLinkDialog.displayName = 'ExternalLinkDialog'
