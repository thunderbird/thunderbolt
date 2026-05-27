/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { m } from 'framer-motion'
import { MoreHorizontal, Pin, Play, SquarePen, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import type { Skill } from '@/types'

/**
 * Row used in the Enabled and Disabled sections of `/settings/skills`.
 * Wrapped in `m.li layoutId={skill.id}` so framer-motion animates the row's
 * move between sections when the user toggles enabled state — the row
 * unmounts from one `<ul>` and remounts in the other, and the shared
 * layoutId carries position state across the transition.
 *
 * Pinning is managed from the chat composer, not here. A small pin glyph
 * on the right of the row indicates a skill is currently pinned — it's a
 * read-only badge, not a control.
 */
export const LibraryRow = ({
  skill,
  enabled,
  isPinned,
  isActive,
  onSelect,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  skill: Skill
  enabled: boolean
  isPinned: boolean
  isActive: boolean
  onSelect: (id: string) => void
  onToggleEnabled: (id: string, next: boolean) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) => {
  const navigate = useNavigate()

  return (
    <m.li
      layout
      layoutId={skill.id}
      // Softened animation: lower stiffness + a brief delay so toggling
      // enabled state doesn't feel snappy / flashy. The row crosses between
      // the Enabled and Disabled sections; the gentler spring + delay reads
      // as "settling into place" rather than "popping."
      transition={{ type: 'spring', damping: 32, stiffness: 220, mass: 0.85, delay: 0.05 }}
    >
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
          {isPinned && (
            <Pin size={12} className="shrink-0 fill-current text-muted-foreground" aria-label="Pinned" role="img" />
          )}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Open /${skill.name} menu`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:bg-foreground/10 aria-expanded:opacity-100"
            >
              <MoreHorizontal size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                onEdit(skill.id)
              }}
              className="cursor-pointer"
            >
              <SquarePen />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                // Navigate to /chats/new directly — the `/` index route does
                // `<Navigate to="/chats/new" replace />` which does NOT forward
                // `location.state`, so a `state` payload sent to `/` is lost.
                navigate('/chats/new', { state: { runSkill: skill.name } })
              }}
              className="cursor-pointer"
            >
              <Play />
              Run in chat
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation()
                onDelete(skill.id)
              }}
              className="cursor-pointer"
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
