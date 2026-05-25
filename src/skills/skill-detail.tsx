/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as AccordionPrimitive from '@radix-ui/react-accordion'
import {
  Calendar,
  ChevronDown,
  ChevronLeft,
  Code,
  Info,
  MoreHorizontal,
  Pin,
  Play,
  Power,
  SquarePen,
  Trash2,
  User,
} from 'lucide-react'
import { type ComponentType, type ReactNode } from 'react'
import { Link } from 'react-router'

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
import { renderHighlightedSkillTokens } from './highlight-skill-tokens'
import type { SkillSource } from './skills-data'

const sourceLabel: Record<SkillSource, string> = {
  marketplace: 'Marketplace',
  local: 'Local',
}

const sourceIcon: Record<SkillSource, ComponentType<{ size?: number }>> = {
  local: Code,
  marketplace: Code,
}

const MetaItem = ({ icon, value }: { icon: ReactNode; value: string }) => (
  <span className="flex items-center gap-1 text-base leading-tight text-muted-foreground [&_svg]:size-3.5">
    {icon}
    <span>{value}</span>
  </span>
)

export const SkillDetail = ({
  name = '/weekly-review',
  source = 'local',
  createdBy = 'Mozilla',
  updated = '04.23.2026',
  pinned = true,
  enabled = true,
  version,
  description = '',
  instruction = '',
  onTogglePin,
  onToggleEnabled,
  onEdit,
  onDelete,
  onBack,
  isValidSkillRef,
}: {
  name?: string
  source?: SkillSource
  createdBy?: string
  updated?: string
  pinned?: boolean
  enabled?: boolean
  version?: string
  description?: string
  instruction?: string
  onTogglePin?: () => void
  onToggleEnabled?: (next: boolean) => void
  onEdit?: () => void
  onDelete?: () => void
  onBack?: () => void
  isValidSkillRef?: (token: string) => boolean
}) => {
  const SourceIcon = sourceIcon[source]
  const { isMobile } = useIsMobile()

  return (
    <section className="flex h-full flex-1 flex-col gap-4 overflow-hidden border-l border-border/50 bg-background px-4 py-4 md:px-5 text-foreground">
      <header className="flex flex-col gap-5 md:gap-2.5">
        <div className="relative flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {onBack && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onBack}
                aria-label="Back to skills"
                className="size-8 shrink-0 rounded-md border border-border text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="size-5 md:size-4" />
              </Button>
            )}
            {!isMobile && (
              <button
                type="button"
                onClick={onTogglePin}
                aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
                aria-pressed={pinned}
                className={`shrink-0 transition-colors ${pinned ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <Pin size={20} strokeWidth={1.75} fill={pinned ? 'currentColor' : 'none'} />
              </button>
            )}
            {!isMobile && <h2 className="text-xl leading-tight text-foreground">{name}</h2>}
          </div>
          {isMobile && (
            <h2 className="absolute left-1/2 -translate-x-1/2 text-xl text-foreground pointer-events-none truncate max-w-[60%] text-center">
              {name}
            </h2>
          )}
          <div className="flex items-center gap-2">
            {!isMobile && source === 'marketplace' && (
              <Button
                variant="outline"
                size="lg"
                className="h-9 gap-[9px] px-3 text-sm font-normal [&_svg:not([class*='size-'])]:size-4"
              >
                <Code />
                Source Code
              </Button>
            )}
            {!isMobile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Wrapping the Switch in a span isolates the tooltip's own
                      `data-state` attribute from the Switch's `data-state`.
                      Without this, Radix's <TooltipTrigger asChild> overwrites
                      Switch's data-state="checked|unchecked" with its own
                      closed|delayed-open value, and the colored variants stop
                      matching. */}
                  <span className="inline-flex">
                    <Switch
                      checked={enabled}
                      onCheckedChange={(next) => onToggleEnabled?.(next)}
                      aria-label={enabled ? 'Disable skill' : 'Enable skill'}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {enabled ? "Disable skill. AI won't use it and pinned skills get unpinned." : 'Enable skill'}
                </TooltipContent>
              </Tooltip>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  aria-label="More"
                  className="size-8 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&_svg:not([class*='size-'])]:size-5"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                className="flex w-56 flex-col gap-0 rounded-xl border border-border bg-card px-2 py-3"
              >
                {isMobile && (
                  <>
                    <DropdownMenuItem
                      onSelect={() => onTogglePin?.()}
                      className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
                    >
                      <Pin fill={pinned ? 'currentColor' : 'none'} />
                      {pinned ? 'Unpin skill' : 'Pin skill'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault()
                        onToggleEnabled?.(!enabled)
                      }}
                      className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
                    >
                      <Power />
                      {enabled ? 'Disable skill' : 'Enable skill'}
                    </DropdownMenuItem>
                    {source === 'marketplace' && (
                      <DropdownMenuItem className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4">
                        <Code />
                        Source Code
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                  </>
                )}
                {source === 'local' && (
                  <DropdownMenuItem
                    onClick={() => onEdit?.()}
                    className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
                  >
                    <SquarePen />
                    Edit
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4">
                  <Link to={`/?run=${encodeURIComponent(name)}`}>
                    <Play />
                    Run in chat
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onDelete?.()}
                  className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
                >
                  <Trash2 />
                  {source === 'local' ? 'Delete' : 'Uninstall'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <MetaItem icon={<SourceIcon />} value={sourceLabel[source]} />
          <MetaItem icon={<User />} value={createdBy} />
          <MetaItem icon={<Calendar />} value={updated} />
          {source === 'marketplace' && version && <MetaItem icon={<Info />} value={version} />}
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
            <p className="whitespace-pre-wrap text-base leading-snug text-foreground">
              {isValidSkillRef
                ? renderHighlightedSkillTokens(description, isValidSkillRef, { saved: true })
                : description}
            </p>
          </AccordionContent>
        </AccordionItem>

        {/* Instructions uses AccordionPrimitive directly so we can apply flex-1
            to fill remaining vertical space when open. The shared
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
              {isValidSkillRef
                ? renderHighlightedSkillTokens(instruction, isValidSkillRef, { saved: true })
                : instruction}
            </div>
          </AccordionPrimitive.Content>
        </AccordionPrimitive.Item>
      </Accordion>
    </section>
  )
}
