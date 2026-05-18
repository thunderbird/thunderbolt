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

export const DeleteSkillDialog = ({
  open,
  onOpenChange,
  onConfirm,
  action,
  skillName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  action: 'delete' | 'uninstall'
  skillName: string
}) => {
  const verb = action === 'delete' ? 'Delete' : 'Uninstall'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 bg-background p-8 sm:max-w-[466px]" showCloseButton={false}>
        <DialogHeader className="items-center gap-4 text-center">
          <DialogTitle className="text-xl font-medium text-foreground">
            <span className="block">{verb} skill:</span>
            <span className="block">{skillName}</span>
          </DialogTitle>
          <DialogDescription className="text-base text-muted-foreground">
            Are you sure you want to {verb.toLowerCase()} this skill?
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <DialogClose asChild>
            <Button variant="outline" size="lg" className="h-12 w-full">
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" size="lg" onClick={onConfirm} className="h-12 w-full">
            {verb}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
