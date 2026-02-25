import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export type SyncEnableWarningDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}

/**
 * Reusable dialog shown before enabling cloud sync. Warns that synced data
 * is not encrypted. Use in preferences and header sync controls.
 */
export const SyncEnableWarningDialog = ({ open, onOpenChange, onConfirm }: SyncEnableWarningDialogProps) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Enable sync?</AlertDialogTitle>
        <AlertDialogDescription>
          At this time, synced data is not encrypted. Enabling sync will store your data on our servers without
          encryption. Do you want to continue?
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} className="bg-destructive text-white hover:bg-destructive/90">
          Enable sync without encryption
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
