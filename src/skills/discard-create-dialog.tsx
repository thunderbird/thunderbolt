/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export const DiscardCreateDialog = ({
  open,
  onOpenChange,
  onConfirm,
  title = 'Leave without creating?',
  description = "You'll lose what you've added so far.",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  title?: string
  description?: string
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-6 bg-background p-8 sm:max-w-[466px]" showCloseButton={false}>
      <DialogHeader className="items-center gap-3 text-center">
        <DialogTitle className="text-xl font-medium text-foreground">{title}</DialogTitle>
        <DialogDescription className="text-base text-muted-foreground">{description}</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <DialogClose asChild>
          <Button variant="outline" size="lg" className="h-12 w-full">
            Keep editing
          </Button>
        </DialogClose>
        <Button variant="destructive" size="lg" onClick={onConfirm} className="h-12 w-full">
          Discard
        </Button>
      </div>
    </DialogContent>
  </Dialog>
)
