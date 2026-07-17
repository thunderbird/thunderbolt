/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info, MoreVertical, SquarePen, Trash2, X } from 'lucide-react'

import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Detail panel for a single skill. Pinning is managed from the chat composer
 * and enable/disable lives on the list row's switch; this view shows the
 * skill's content plus edit / delete controls.
 *
 * Deliberately transparent: on desktop it renders inside the slide-in
 * surface card (one continuous background, see SkillsView), on mobile inside
 * the full-screen overlay — so content sits flat on the surface with hairline
 * dividers between sections instead of nested cards.
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
  return (
    <section className="flex h-full flex-1 flex-col overflow-hidden px-4 pb-5 md:px-6 text-foreground">
      {/* Mobile keeps the list's title-row height (shared page chrome); the
          desktop card gets a taller header so the title has room to breathe. */}
      <header className="relative flex h-[var(--touch-height-xl)] shrink-0 items-center justify-between gap-4 md:h-16">
        <h2 className="min-w-0 truncate text-xl leading-tight text-foreground">{name}</h2>
        {/* Desktop: pin the actions to the card's top-right corner, 8px from
            both edges (right: 24px padding − 16px), independent of the taller
            header so the X stays equidistant from top and right. */}
        <div className="flex shrink-0 items-center gap-0.5 md:absolute md:-right-4 md:top-2">
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
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close details"
            className={mutedIconButtonClass}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      {/* The whole body (description + instructions) scrolls as one area. */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pt-4">
        <div className="flex shrink-0 flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
          </h3>
          <p className="whitespace-pre-wrap text-base leading-snug text-foreground">{description}</p>
        </div>

        <div className="h-px shrink-0 bg-border/60" />

        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Instructions</h3>
          <div className="whitespace-pre-wrap pb-1 text-base leading-snug text-foreground">{instruction}</div>
        </div>
      </div>
    </section>
  )
}
