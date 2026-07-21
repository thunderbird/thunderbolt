/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArrowRight } from 'lucide-react'

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
import { skillDisplayName } from './display'

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
  onJumpToDependent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  action: DependentsAction
  /** Human display name of the skill being disabled/deleted. */
  targetName: string
  dependents: Skill[]
  onConfirm: () => void
  onJumpToDependent: (id: string) => void
}) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {verbLabel[action]} {targetName}?
        </AlertDialogTitle>
        <AlertDialogDescription>
          {dependents.length === 1
            ? `One skill references this. If you ${action} it, that skill may no longer resolve:`
            : `${dependents.length} skills reference this. If you ${action} it, they may no longer resolve:`}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="flex flex-col gap-1.5">
        {dependents.map((dep) => (
          <li key={dep.id}>
            <button
              type="button"
              onClick={() => onJumpToDependent(dep.id)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <span className="min-w-0 truncate">{skillDisplayName(dep)}</span>
              <ArrowRight size={14} className="shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button variant="destructive" onClick={onConfirm}>
          {verbLabel[action]} skill
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
