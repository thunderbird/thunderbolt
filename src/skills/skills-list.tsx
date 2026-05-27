/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LayoutGroup, m } from 'framer-motion'
import { Menu, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import type { Skill } from '@/types'
import { LibraryRow } from './library-row'
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

  // Pinned skills render in their own drag-reorder section above the library;
  // exclude them from the enabled/disabled split below.
  const { enabledRows, disabledRows } = useMemo(() => {
    const query = search.trim().toLowerCase()
    const unpinned = skills.filter((s) => !isPinned(s.id))
    const filtered = query === '' ? unpinned : unpinned.filter((s) => s.name.toLowerCase().includes(query))
    const enabled: Skill[] = []
    const disabled: Skill[] = []
    for (const s of filtered) {
      ;(isEnabled(s.id) ? enabled : disabled).push(s)
    }
    return { enabledRows: enabled, disabledRows: disabled }
  }, [skills, search, isEnabled, isPinned])

  return (
    <section className="flex h-full w-full flex-col gap-3 border-r border-sidebar-border bg-background px-4 pb-4 md:px-5 text-foreground md:w-[378px] md:shrink-0">
      {/* Title row matches the sidebar's Thunderbolt header height so the
          "Skills" heading sits at the same y-position as the app logo. */}
      <header className="relative flex h-[var(--touch-height-xl)] shrink-0 items-center justify-between gap-2">
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

      {/* LayoutGroup links the Enabled and Disabled <ul>s so a row's
          `layoutId` carries through when toggling enabled state — the row
          unmounts from one list and remounts in the other, and framer-motion
          animates between the two positions. */}
      <LayoutGroup>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <PinnedSection
            pinned={pinned}
            activeSkillId={activeSkillId}
            isEnabled={isEnabled}
            onToggleEnabled={onToggleEnabled}
            onTogglePin={onTogglePin}
            onSelectSkill={onSelectSkill}
            onEdit={onEdit}
            onDelete={onDelete}
            onReorder={onReorderPins}
          />

          {enabledRows.length > 0 && (
            <m.ul layout className="flex flex-col gap-1.5">
              {enabledRows.map((skill) => (
                <LibraryRow
                  key={skill.id}
                  skill={skill}
                  enabled
                  isPinned={false}
                  isActive={skill.id === activeSkillId}
                  onSelect={onSelectSkill}
                  onToggleEnabled={onToggleEnabled}
                  onTogglePin={onTogglePin}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              ))}
            </m.ul>
          )}

          {disabledRows.length > 0 && (
            <m.div layout className="flex flex-col gap-1">
              <h2 className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Disabled</h2>
              <m.ul layout className="flex flex-col gap-1.5">
                {disabledRows.map((skill) => (
                  <LibraryRow
                    key={skill.id}
                    skill={skill}
                    enabled={false}
                    isPinned={false}
                    isActive={skill.id === activeSkillId}
                    onSelect={onSelectSkill}
                    onToggleEnabled={onToggleEnabled}
                    onTogglePin={onTogglePin}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                ))}
              </m.ul>
            </m.div>
          )}

          {enabledRows.length === 0 && disabledRows.length === 0 && pinned.length === 0 && (
            // Search-empty state. The user-deleted-everything empty state lives
            // a level up in SkillsView.
            <p className="flex h-32 items-center justify-center text-sm text-muted-foreground">No matching skills.</p>
          )}
        </div>
      </LayoutGroup>
    </section>
  )
}
