/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

export const DeleteSkillDialog = ({
  open,
  onOpenChange,
  onConfirm,
  skillName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  /** Human display name of the skill being deleted. */
  skillName: string
}) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {skillName}?</AlertDialogTitle>
        <AlertDialogDescription>
          This will permanently delete the skill. Other skills that reference it may no longer resolve.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button variant="destructive" onClick={onConfirm}>
          Delete skill
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
