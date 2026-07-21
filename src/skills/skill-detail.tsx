/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info, MoreVertical, SquarePen, Trash2 } from 'lucide-react'

import { DetailDivider, DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Detail panel for a single skill. Pinning is managed from the chat composer
 * and enable/disable lives on the list row's switch; this view shows the
 * skill's content plus edit / delete controls.
 */
export const SkillDetail = ({
  name,
  description,
  instruction,
  onEdit,
  onDelete,
  onClose,
}: {
  /** Display name (the human label). */
  name: string
  description: string
  instruction: string
  onEdit: () => void
  onDelete: () => void
  /** Close (X, right of the actions menu) — dismisses the desktop slide-in
   *  panel or the mobile overlay. */
  onClose: () => void
}) => {
  const actionsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More" className={mutedIconButtonClass}>
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem onClick={onEdit} className="cursor-pointer">
          <SquarePen />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDelete} className="cursor-pointer">
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <DetailPanel title={name} actions={actionsMenu} onClose={onClose}>
      <div className="flex shrink-0 flex-col gap-2">
        <DetailSectionTitle>
          Description
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label="What is this for?"
                className="inline-flex items-center text-muted-foreground hover:text-foreground"
              >
                <Info size={13} strokeWidth={1.75} />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Helps the agent decide when to use this skill. Be specific about when it applies.
            </TooltipContent>
          </Tooltip>
        </DetailSectionTitle>
        <p className="whitespace-pre-wrap text-base leading-snug text-foreground">{description}</p>
      </div>

      <DetailDivider />

      <div className="flex flex-col gap-2">
        <DetailSectionTitle>Instructions</DetailSectionTitle>
        <div className="whitespace-pre-wrap pb-1 text-base leading-snug text-foreground">{instruction}</div>
      </div>
    </DetailPanel>
  )
}
