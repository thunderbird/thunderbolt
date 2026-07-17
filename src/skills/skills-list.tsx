/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LayoutGroup, m } from 'framer-motion'
import { Menu, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { PageSearch } from '@/components/ui/page-search'
import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import type { Skill } from '@/types'
import { LibraryRow, skillRowTransition } from './library-row'

/**
 * Sidebar list for `/settings/skills`. Skills are grouped by enabled state
 * (Enabled at top, Disabled below); each group is alphabetical, inherited
 * from `getAllSkills`'s `ORDER BY name ASC` in the DAL. Pinning is managed
 * from the chat composer per product direction — this list offers no
 * pin / reorder controls and no pinned-state indicator.
 */
export const SkillsList = ({
  skills,
  activeSkillId,
  isEnabled,
  onToggleEnabled,
  onCreate,
  onSelectSkill,
}: {
  skills: Skill[]
  activeSkillId: string | null
  isEnabled: (id: string) => boolean
  onToggleEnabled: (id: string, next: boolean) => void
  onCreate: () => void
  onSelectSkill: (id: string) => void
}) => {
  const [search, setSearch] = useState('')
  const { isMobile } = useIsMobile()
  const { toggleSidebar } = useSidebar()

  const { enabledRows, disabledRows } = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = query === '' ? skills : skills.filter((s) => s.name.toLowerCase().includes(query))
    const enabled: Skill[] = []
    const disabled: Skill[] = []
    for (const s of filtered) {
      ;(isEnabled(s.id) ? enabled : disabled).push(s)
    }
    return { enabledRows: enabled, disabledRows: disabled }
  }, [skills, search, isEnabled])

  return (
    <section className="mx-auto flex h-full w-full max-w-[760px] flex-col gap-3 bg-background px-4 pb-4 md:px-5 text-foreground">
      <PageSearch onSearch={setSearch}>
        {/* On mobile this row is the page's only chrome (the settings-level
            Header is skipped there) and matches the sidebar header height so
            the "Skills" heading sits at the same y-position as the app logo. */}
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
          <div className="flex items-center gap-2">
            <PageSearch.Button className="size-8 rounded-md" />
            <Button
              variant="outline"
              size="icon"
              aria-label="Create skill"
              className="size-8 rounded-md"
              onClick={onCreate}
            >
              <Plus />
            </Button>
          </div>
        </header>

        <PageSearch.Input
          placeholder="Search skills"
          onSearch={setSearch}
          wrapperClassName="pr-0"
          className="h-9 rounded-lg border-border bg-card text-sm placeholder:text-muted-foreground"
        />
      </PageSearch>

      {/* LayoutGroup links the Enabled and Disabled <ul>s so a row's
          `layoutId` carries through when toggling enabled state — the row
          unmounts from one list and remounts in the other, and framer-motion
          animates between the two positions. */}
      <LayoutGroup>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {/* `layout="position"` on the wrappers (not full `layout`) so the
              containers reposition without animating their bounding-box
              SIZE — full `layout` interpolates height via a transform,
              which visibly stretches the `<h2>` inside as the section
              grows by a row. Children's cross-section positions are
              still smooth: `LibraryRow`'s `m.li layoutId` migrates the
              row across with its own delayed spring (`skillRowTransition`),
              and the wrapper's height jumps instantly to fit. */}
          {enabledRows.length > 0 && (
            <m.ul layout="position" transition={skillRowTransition} className="flex flex-col gap-1.5">
              {enabledRows.map((skill) => (
                <LibraryRow
                  key={skill.id}
                  skill={skill}
                  enabled
                  isActive={skill.id === activeSkillId}
                  onSelect={onSelectSkill}
                  onToggleEnabled={onToggleEnabled}
                />
              ))}
            </m.ul>
          )}

          {disabledRows.length > 0 && (
            <m.div layout="position" transition={skillRowTransition} className="flex flex-col gap-1">
              <h2 className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Disabled</h2>
              <m.ul layout="position" transition={skillRowTransition} className="flex flex-col gap-1.5">
                {disabledRows.map((skill) => (
                  <LibraryRow
                    key={skill.id}
                    skill={skill}
                    enabled={false}
                    isActive={skill.id === activeSkillId}
                    onSelect={onSelectSkill}
                    onToggleEnabled={onToggleEnabled}
                  />
                ))}
              </m.ul>
            </m.div>
          )}

          {skills.length === 0 ? (
            // The "I deleted everything" empty state — the list is the page's
            // main surface now, so the create CTA lives here.
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <h2 className="text-xl">No skills yet</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Skills are reusable instruction templates you summon in chat with{' '}
                <code className="rounded-sm bg-secondary px-1 font-mono text-xs">/name</code>.
              </p>
              <Button size="sm" onClick={onCreate}>
                <Plus />
                Create your first skill
              </Button>
            </div>
          ) : (
            enabledRows.length === 0 &&
            disabledRows.length === 0 && (
              // Search-empty state.
              <p className="flex h-32 items-center justify-center text-sm text-muted-foreground">No matching skills.</p>
            )
          )}
        </div>
      </LayoutGroup>
    </section>
  )
}
