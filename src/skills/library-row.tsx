/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { m } from 'framer-motion'
import { SquarePen, Trash2 } from 'lucide-react'

import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Switch } from '@/components/ui/switch'
import type { Skill } from '@/types'
import { skillDisplayName } from './display'

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
  onSelect,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  skill: Skill
  enabled: boolean
  isActive: boolean
  onSelect: (id: string) => void
  onToggleEnabled: (id: string, next: boolean) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) => {
  return (
    <m.li layout layoutId={skill.id} transition={skillRowTransition}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SettingsSelectableRow
            title={skillDisplayName(skill)}
            subtitle={skill.description}
            selected={isActive}
            dimmed={!enabled}
            onSelect={() => onSelect(skill.id)}
            ariaLabel={`Open ${skillDisplayName(skill)}`}
            trailing={
              <Switch
                checked={enabled}
                onCheckedChange={(next) => onToggleEnabled(skill.id, next)}
                aria-label={`${enabled ? 'Disable' : 'Enable'} ${skillDisplayName(skill)}`}
              />
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-56">
          <ContextMenuItem onClick={() => onEdit(skill.id)} className="cursor-pointer">
            <SquarePen className="size-4 mr-2" />
            Edit
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onDelete(skill.id)} className="cursor-pointer">
            <Trash2 className="size-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </m.li>
  )
}
