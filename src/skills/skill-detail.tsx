/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { ChevronDown, ChevronLeft, Info, MoreHorizontal, Plus, Power, SquarePen, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'

/**
 * Detail / edit panel for a single skill. Pinning is managed from the chat
 * composer; this view shows the skill's content + enable / edit / delete /
 * run-in-chat controls.
 */
export const SkillDetail = ({
  name,
  description,
  instruction,
  enabled,
  canEdit = true,
  canDelete = true,
  onToggleEnabled,
  onEdit,
  onDelete,
  onBack,
}: {
  name: string
  description: string
  instruction: string
  enabled: boolean
  /** Defaults to true. Mirrors `add_skills`; gates the enable toggle + Edit menu item. */
  canEdit?: boolean
  /** Defaults to true. Mirrors the workspace `remove_skills` permission. */
  canDelete?: boolean
  onToggleEnabled: (next: boolean) => void
  onEdit: () => void
  onDelete: () => void
  onBack?: () => void
}) => {
  const { isMobile } = useIsMobile()
  const navigate = useNavigate()

  const runInChat = () => {
    // Router state (not a URL param) by design: the entry point is internal
    // navigation only in v1 — no URL surface, no deep-linkability. Target
    // `/chats/new` directly because the `/` index route's `<Navigate replace />`
    // wrapper drops `location.state` during the redirect.
    navigate('/chats/new', { state: { runSkill: name } })
  }

  return (
    <section className="flex h-full flex-1 flex-col gap-4 overflow-hidden bg-background px-4 pb-4 md:px-5 text-foreground">
      <header className="flex flex-col gap-5 md:gap-2.5">
        {/* Title row matches the sidebar's app-logo height so the skill name
            sits at the same y-position as the Thunderbolt label. */}
        <div className="relative flex h-[var(--touch-height-xl)] shrink-0 items-center justify-between gap-4">
          <div className="flex items-center gap-2">
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
            {!isMobile && <h2 className="text-xl leading-tight text-foreground">/{name}</h2>}
          </div>
          {isMobile && (
            <h2 className="absolute left-1/2 -translate-x-1/2 truncate max-w-[60%] text-center text-xl text-foreground pointer-events-none">
              /{name}
            </h2>
          )}
          <div className="flex items-center gap-2">
            {!isMobile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Wrap the Switch so the tooltip's own data-state doesn't
                      clobber the Switch's checked|unchecked data-state and
                      break the colored variants. */}
                  <span className="inline-flex">
                    <Switch
                      checked={enabled}
                      disabled={!canEdit}
                      onCheckedChange={onToggleEnabled}
                      aria-label={enabled ? 'Disable skill' : 'Enable skill'}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {enabled ? "Disable skill. The AI won't use it, and it will be unpinned." : 'Enable skill'}
                </TooltipContent>
              </Tooltip>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More"
                  className="size-8 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&_svg:not([class*='size-'])]:size-5"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                {isMobile && canEdit && (
                  <>
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault()
                        onToggleEnabled(!enabled)
                      }}
                      className="cursor-pointer"
                    >
                      <Power />
                      {enabled ? 'Disable skill' : 'Enable skill'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {canEdit && (
                  <DropdownMenuItem onClick={onEdit} className="cursor-pointer">
                    <SquarePen />
                    Edit
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={runInChat} className="cursor-pointer">
                  <Plus />
                  Add to chat
                </DropdownMenuItem>
                {canDelete && (
                  <DropdownMenuItem onClick={onDelete} className="cursor-pointer">
                    <Trash2 />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <Accordion
        type="multiple"
        defaultValue={['description', 'instructions']}
        className="mt-2 flex min-h-0 flex-1 flex-col gap-4"
      >
        <AccordionItem value="description" className="rounded-xl border-b-0 bg-secondary px-4 dark:bg-sidebar">
          <AccordionTrigger className="py-3 text-base leading-tight text-muted-foreground hover:no-underline">
            <div className="flex items-center gap-0.5">
              <span>Description</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    aria-label="What is this for?"
                    className="ml-1 inline-flex items-center text-muted-foreground hover:text-foreground"
                  >
                    <Info size={14} strokeWidth={1.75} />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Helps the agent decide when to use this skill. Be specific about when it applies.
                </TooltipContent>
              </Tooltip>
            </div>
          </AccordionTrigger>
          <AccordionContent className="pb-4 pt-0">
            <p className="whitespace-pre-wrap text-base leading-snug text-foreground">{description}</p>
          </AccordionContent>
        </AccordionItem>

        {/* Instructions uses AccordionPrimitive directly so it can flex-1 to
            fill remaining vertical space when open. The shared
            AccordionContent's height-keyframe animation conflicts with flex-1
            sizing, so this item snaps open/closed without animation. */}
        <AccordionPrimitive.Item
          value="instructions"
          className="flex flex-col rounded-xl bg-secondary px-4 data-[state=open]:min-h-0 data-[state=open]:flex-1 dark:bg-sidebar"
        >
          <AccordionPrimitive.Header className="flex">
            <AccordionPrimitive.Trigger className="flex flex-1 items-center justify-between gap-4 py-3 text-base leading-tight text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&[data-state=open]>svg]:rotate-180">
              Instructions
              <ChevronDown className="text-muted-foreground pointer-events-none size-4 shrink-0 transition-transform duration-200" />
            </AccordionPrimitive.Trigger>
          </AccordionPrimitive.Header>
          <AccordionPrimitive.Content className="overflow-hidden data-[state=open]:flex data-[state=open]:min-h-0 data-[state=open]:flex-1 data-[state=open]:flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap pb-4 text-base leading-snug text-foreground">
              {instruction}
            </div>
          </AccordionPrimitive.Content>
        </AccordionPrimitive.Item>
      </Accordion>
    </section>
  )
}
