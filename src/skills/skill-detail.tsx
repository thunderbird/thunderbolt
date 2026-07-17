/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChevronLeft, Info, MoreVertical, SquarePen, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'

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
  onBack,
  onClose,
}: {
  name: string
  description: string
  instruction: string
  onEdit: () => void
  onDelete: () => void
  /** Mobile back chevron (left side). */
  onBack?: () => void
  /** Desktop close (X, right side) for the slide-in panel. */
  onClose?: () => void
}) => {
  const { isMobile } = useIsMobile()

  return (
    <section className="flex h-full flex-1 flex-col overflow-hidden px-4 pb-5 md:px-6 text-foreground">
      {/* Mobile keeps the list's title-row height (shared page chrome); the
          desktop card gets a taller header so the title has room to breathe. */}
      <header className="relative flex h-[var(--touch-height-xl)] shrink-0 items-center justify-between gap-4 md:h-16">
        <div className="flex min-w-0 items-center gap-2">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label="Back to skills"
              className="size-8 shrink-0 rounded-md border border-border text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-5 md:size-4" />
            </Button>
          )}
          {!isMobile && <h2 className="truncate text-xl leading-tight text-foreground">/{name}</h2>}
        </div>
        {isMobile && (
          <h2 className="absolute left-1/2 -translate-x-1/2 truncate max-w-[60%] text-center text-xl text-foreground pointer-events-none">
            /{name}
          </h2>
        )}
        {/* Desktop: pin the actions to the card's top-right corner, 8px from
            both edges (right: 24px padding − 16px), independent of the taller
            header so the X stays equidistant from top and right. */}
        <div className="flex shrink-0 items-center gap-0.5 md:absolute md:-right-4 md:top-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More"
                className="size-8 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&_svg:not([class*='size-'])]:size-5"
              >
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
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close details"
              className="size-8 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="size-4" />
            </Button>
          )}
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
