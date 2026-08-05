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
import type { Skill } from '@/types'

export type DependentsAction = 'disable' | 'delete'

const verbLabel: Record<DependentsAction, string> = {
  disable: 'Disable',
  delete: 'Delete',
}

export const DependentsDialog = ({
  open,
  onOpenChange,
  action,
  targetName,
  dependents,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  action: DependentsAction
  /** Human display name of the skill being disabled/deleted. */
  targetName: string
  dependents: Skill[]
  onConfirm: () => void
}) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {verbLabel[action]} {targetName}?
        </AlertDialogTitle>
        <AlertDialogDescription>
          {dependents.length === 1
            ? `One skill references this. If you ${action} it, that skill may no longer resolve.`
            : `${dependents.length} skills reference this. If you ${action} it, they may no longer resolve.`}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button variant="destructive" onClick={onConfirm}>
          {verbLabel[action]} skill
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
