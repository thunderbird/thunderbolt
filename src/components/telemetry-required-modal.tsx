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

export type TelemetryRequiredModalRef = {
  open: (featureName?: string | null) => void
  close: () => void
}

type TelemetryRequiredModalProps = {
  onEnableTelemetry: (featureName?: string | null) => Promise<void>
}

export const TelemetryRequiredModal = forwardRef<TelemetryRequiredModalRef, TelemetryRequiredModalProps>(
  ({ onEnableTelemetry }, ref) => {
    const [open, setOpen] = useState(false)
    const [featureName, setFeatureName] = useState<string | null>(null)

    const handleOpen = (featureName?: string | null) => {
      setFeatureName(featureName || null)
      setOpen(true)
    }

    const handleClose = () => {
      setOpen(false)
      setFeatureName(null)
    }

    const handleEnableTelemetry = async () => {
      await onEnableTelemetry(featureName)
      handleClose()
    }

    useImperativeHandle(ref, () => ({
      open: handleOpen,
      close: handleClose,
    }))

    return (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Telemetry Required</AlertDialogTitle>
            <AlertDialogDescription>
              In order to use preview features, we ask that you help us improve the product by sharing telemetry data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleEnableTelemetry}>Enable Telemetry</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  },
)

TelemetryRequiredModal.displayName = 'TelemetryRequiredModal'
