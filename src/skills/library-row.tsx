/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { m } from 'framer-motion'
import { MoreHorizontal, Pin, PinOff, Play, SquarePen, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import type { Skill } from '@/types'

/**
 * Row used in the Enabled and Disabled library sections.
 * Wrapped in `m.li layoutId={skill.id}` so framer-motion animates the row's
 * move between sections when the user toggles enabled state — the row
 * unmounts from one `<ul>` and remounts in the other, and the shared
 * layoutId carries position state across the transition.
 *
 * Pinned rows live in `pinned-section.tsx` and use dnd-kit's transform for
 * drag-reorder, which doesn't compose cleanly with layout animations, so
 * pinned <-> library transitions don't animate. That's acceptable —
 * enable/disable is the high-frequency interaction.
 */
export const LibraryRow = ({
  skill,
  enabled,
  isPinned,
  isActive,
  onSelect,
  onToggleEnabled,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  skill: Skill
  enabled: boolean
  isPinned: boolean
  isActive: boolean
  onSelect: (id: string) => void
  onToggleEnabled: (id: string, next: boolean) => void
  onTogglePin: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) => {
  const navigate = useNavigate()

  return (
    <m.li layout layoutId={skill.id} transition={{ type: 'spring', damping: 28, stiffness: 380, mass: 0.6 }}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(skill.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(skill.id)
          }
        }}
        className={`group flex h-[var(--touch-height-default)] w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-base transition-colors ${
          enabled ? 'text-foreground' : 'text-muted-foreground/60'
        } ${isActive ? 'bg-accent' : 'hover:bg-accent'}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Switch
              checked={enabled}
              onCheckedChange={(next) => onToggleEnabled(skill.id, next)}
              aria-label={enabled ? `Disable /${skill.name}` : `Enable /${skill.name}`}
            />
          </span>
          <span className="truncate">/{skill.name}</span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Open /${skill.name} menu`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:bg-foreground/10 aria-expanded:opacity-100"
            >
              <MoreHorizontal size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="flex w-56 flex-col gap-0 rounded-xl border border-border bg-card px-2 py-3"
          >
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin(skill.id)
              }}
              className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
            >
              {isPinned ? <PinOff /> : <Pin />}
              {isPinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                onEdit(skill.id)
              }}
              className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
            >
              <SquarePen />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                navigate('/', { state: { runSkill: skill.name } })
              }}
              className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
            >
              <Play />
              Run in chat
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                onDelete(skill.id)
              }}
              className="h-9 gap-1.5 px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </m.li>
  )
}
