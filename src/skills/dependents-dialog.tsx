/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AlertTriangle, ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { Skill } from './skills-data'

export type DependentsAction = 'disable' | 'delete' | 'uninstall'

const verbLower: Record<DependentsAction, string> = {
  disable: 'disable',
  delete: 'delete',
  uninstall: 'uninstall',
}

const verbLabel: Record<DependentsAction, string> = {
  disable: 'Disable',
  delete: 'Delete',
  uninstall: 'Uninstall',
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
  targetName: string
  dependents: Skill[]
  onConfirm: () => void
  onJumpToDependent: (name: string) => void
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-0 bg-card p-6 sm:max-w-[400px]" showCloseButton={false}>
      <div className="flex flex-col gap-3 pr-6">
        <DialogTitle className="flex items-center gap-2 text-base font-medium text-foreground">
          <AlertTriangle size={16} className="shrink-0 text-yellow-500" />
          <span>Other skills contain &ldquo;{targetName}&rdquo;</span>
        </DialogTitle>
        <DialogDescription className="pl-6 text-sm text-muted-foreground">
          If you {verbLower[action]} the skill the following skills may break
        </DialogDescription>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {dependents.map((dep) => (
          <li key={dep.name}>
            <button
              type="button"
              onClick={() => onJumpToDependent(dep.name)}
              className="flex w-full items-center justify-between rounded-xl border border-border-strong bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-bg-hover"
            >
              <span>{dep.name}</span>
              <ArrowRight size={16} className="text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-6 grid grid-cols-2 gap-3">
        <DialogClose asChild>
          <Button variant="outline" size="lg" className="h-9 w-full text-sm">
            Cancel
          </Button>
        </DialogClose>
        <Button variant="destructive" size="lg" onClick={onConfirm} className="h-9 w-full text-sm">
          {verbLabel[action]}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
)
