/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Menu, MoreHorizontal, Pin, PinOff, Play, Plus, Search, SquarePen, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useSidebar } from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import { useIsMobile } from '@/hooks/use-mobile'
import type { Skill } from '@/types'
import { PinnedSection } from './pinned-section'

export const SkillsList = ({
  skills,
  pinned,
  activeSkillId,
  isEnabled,
  isPinned,
  onToggleEnabled,
  onTogglePin,
  onReorderPins,
  onCreate,
  onSelectSkill,
  onEdit,
  onDelete,
}: {
  skills: Skill[]
  pinned: Skill[]
  activeSkillId: string | null
  isEnabled: (id: string) => boolean
  isPinned: (id: string) => boolean
  onToggleEnabled: (id: string, next: boolean) => void
  onTogglePin: (id: string) => void
  onReorderPins: (ids: string[]) => void
  onCreate: () => void
  onSelectSkill: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}) => {
  const [search, setSearch] = useState('')
  const { isMobile } = useIsMobile()
  const { toggleSidebar } = useSidebar()
  const navigate = useNavigate()

  const visibleSkills = useMemo(() => {
    const query = search.trim().toLowerCase()
    // Pinned skills render in a dedicated drag-reorder section above the main
    // list, so the main list excludes them.
    const unpinned = skills.filter((s) => !isPinned(s.id))
    const filtered = query === '' ? unpinned : unpinned.filter((s) => (s.name ?? '').toLowerCase().includes(query))
    // Disabled rows sink to the bottom of the main list so the actionable
    // items stay near the top regardless of the alphabetical primary sort.
    return [...filtered].sort((a, b) => Number(!isEnabled(a.id)) - Number(!isEnabled(b.id)))
  }, [skills, search, isEnabled, isPinned])

  return (
    <section className="flex h-full w-full flex-col gap-3 border-r border-border/50 bg-background px-4 pb-4 md:px-5 text-foreground md:w-[378px] md:shrink-0">
      <header className="relative flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isMobile && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              aria-label="Open menu"
              className="size-8 -ml-1 rounded-md text-muted-foreground hover:text-foreground"
            >
              <Menu strokeWidth={1.5} />
            </Button>
          )}
          {!isMobile && <h1 className="text-xl leading-tight text-foreground">Skills</h1>}
        </div>
        {isMobile && (
          <h1 className="absolute left-1/2 -translate-x-1/2 text-xl leading-tight text-foreground pointer-events-none">
            Skills
          </h1>
        )}
        <Button
          variant="outline"
          size="icon"
          aria-label="Create skill"
          className="size-8 rounded-md"
          onClick={onCreate}
        >
          <Plus />
        </Button>
      </header>

      <div className="relative">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search skills"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 rounded-lg border-border pl-9 text-sm placeholder:text-muted-foreground"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <PinnedSection
          pinned={pinned}
          activeSkillId={activeSkillId}
          onSelectSkill={onSelectSkill}
          onReorder={onReorderPins}
        />
        <ul className="flex flex-col gap-1.5">
          {visibleSkills.map((skill) => {
            const enabled = isEnabled(skill.id)
            const isActive = skill.id === activeSkillId
            return (
              <li key={skill.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectSkill(skill.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelectSkill(skill.id)
                    }
                  }}
                  className={`group flex h-[var(--touch-height-default)] w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-base transition-colors ${
                    enabled ? 'text-foreground' : 'text-muted-foreground/60'
                  } ${isActive ? 'bg-accent' : 'hover:bg-accent'}`}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2.5">
                    <span
                      className="shrink-0"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Switch
                        checked={enabled}
                        onCheckedChange={(next) => onToggleEnabled(skill.id, next)}
                        aria-label={enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
                      />
                    </span>
                    <span className="truncate">{skill.name}</span>
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Open ${skill.name} menu`}
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
                        {isPinned(skill.id) ? <PinOff /> : <Pin />}
                        {isPinned(skill.id) ? 'Unpin' : 'Pin'}
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
              </li>
            )
          })}
          {visibleSkills.length === 0 && skills.length > 0 && pinned.length === 0 && (
            // Search-empty state (the user-deleted-everything empty state lives
            // a level up in SkillsView).
            <li className="flex h-32 items-center justify-center text-sm text-muted-foreground">No matching skills.</li>
          )}
        </ul>
      </div>
    </section>
  )
}
