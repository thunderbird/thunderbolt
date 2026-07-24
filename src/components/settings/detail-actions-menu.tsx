/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MoreVertical, SquarePen, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** The detail panels' shared ⋯ header menu; children are its menu items. */
export const DetailActionsMenu = ({ children }: { children: ReactNode }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" aria-label="More" className={mutedIconButtonClass}>
        <MoreVertical />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-56">
      {children}
    </DropdownMenuContent>
  </DropdownMenu>
)

/** The standard Edit + Delete item pair for `DetailActionsMenu`. */
export const DetailEditDeleteMenuItems = ({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) => (
  <>
    <DropdownMenuItem onClick={onEdit} className="cursor-pointer">
      <SquarePen />
      Edit
    </DropdownMenuItem>
    <DropdownMenuItem onClick={onDelete} className="cursor-pointer">
      <Trash2 />
      Delete
    </DropdownMenuItem>
  </>
)
