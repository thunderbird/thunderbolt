/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { m } from 'framer-motion'
import { MoreHorizontal, Plus, SquarePen, Trash2 } from 'lucide-react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useWorkspaceNavigate } from '@/lib/active-workspace'
import type { Skill } from '@/types'

/**
 * Shared spring transition for the row's own layout shift AND for the
 * surrounding `<m.ul>` / `<m.div>` wrappers in `SkillsList`. They all
 * animate in lockstep — without the shared delay the wrappers would
 * reflow immediately and the Disabled header would slide up underneath
 * the row that's still frozen mid-toggle.
 */
export const skillRowTransition = { type: 'spring', damping: 32, stiffness: 220, mass: 0.85, delay: 0.3 } as const

/**
 * Row used in the Enabled and Disabled sections of `/settings/skills`.
 * Wrapped in `m.li layoutId={skill.id}` so framer-motion animates the row's
 * move between sections when the user toggles enabled state — the row
 * unmounts from one `<ul>` and remounts in the other, and the shared
 * layoutId carries position state across the transition.
 *
 * The animation has a deliberate ~1.2s delay so the row doesn't jump out
 * from under the user's cursor the instant they toggle the switch — they
 * have a moment to register the state change in place before the row
 * settles into its new section.
 */
export const LibraryRow = ({
  skill,
  enabled,
  isActive,
  canEdit = true,
  canDelete = true,
  onSelect,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  skill: Skill
  enabled: boolean
  isActive: boolean
  /** Defaults to true. Mirrors `add_skills`; gates the enable toggle + Edit menu item. */
  canEdit?: boolean
  /** Defaults to true. Mirrors the workspace `remove_skills` permission. */
  canDelete?: boolean
  onSelect: (id: string) => void
  onToggleEnabled: (id: string, next: boolean) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) => {
  const navigate = useWorkspaceNavigate()

  return (
    <m.li layout layoutId={skill.id} transition={skillRowTransition}>
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
          {/* `inline-flex items-center` here keeps the Switch optically
              centered with the name's text baseline — without it the toggle
              renders flush to the top of the row's content-box. */}
          <span
            className="inline-flex shrink-0 items-center"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Switch
              checked={enabled}
              disabled={!canEdit}
              onCheckedChange={(next) => onToggleEnabled(skill.id, next)}
              aria-label={enabled ? `Disable /${skill.name}` : `Enable /${skill.name}`}
            />
          </span>
          <span className="truncate leading-none">/{skill.name}</span>
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
            {canEdit && (
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
            )}
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
              <Plus />
              Add to chat
            </DropdownMenuItem>
            {canDelete && (
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
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </m.li>
  )
}
