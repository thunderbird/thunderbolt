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
import { memo } from 'react'

type ExternalLinkDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  url: string
  onConfirm: () => void | Promise<void>
}

export const ExternalLinkDialog = memo(({ open, onOpenChange, url, onConfirm }: ExternalLinkDialogProps) => {
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

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Open link</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
})

ExternalLinkDialog.displayName = 'ExternalLinkDialog'
