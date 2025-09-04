import { forwardRef, useImperativeHandle, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'

export type TelemetryWarningModalRef = {
  open: () => void
  close: () => void
}

type TelemetryWarningModalProps = {
  onDisableTelemetry: () => Promise<void>
}

export const TelemetryWarningModal = forwardRef<TelemetryWarningModalRef, TelemetryWarningModalProps>(
  ({ onDisableTelemetry }, ref) => {
    const [open, setOpen] = useState(false)

    const handleClose = () => {
      setOpen(false)
    }

    const handleDisableTelemetry = async () => {
      await onDisableTelemetry()
      handleClose()
    }

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: handleClose,
    }))

    return (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Preview Features Will Be Disabled</AlertDialogTitle>
            <AlertDialogDescription>
              Turning off telemetry will disable all preview features. Are you sure you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisableTelemetry}>Disable Telemetry</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  },
)

TelemetryWarningModal.displayName = 'TelemetryWarningModal'
