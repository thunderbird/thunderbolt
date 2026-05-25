/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  ChevronDown,
  Code,
  Menu,
  MoreHorizontal,
  Pin,
  Play,
  Plus,
  Search,
  SquarePen,
  Store,
  Trash2,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useSidebar } from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import { useIsMobile } from '@/hooks/use-mobile'
import { type Skill, type SkillSource } from './skills-data'

type SourceFilter = 'all' | SkillSource

const sourceFilterLabel: Record<SourceFilter, string> = {
  all: 'All',
  marketplace: 'Marketplace',
  local: 'Local',
}

const SourceFilterSelect = ({ value, onChange }: { value: SourceFilter; onChange: (v: SourceFilter) => void }) => {
  const options: SourceFilter[] = ['all', 'marketplace', 'local']
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-9 justify-between gap-1.5 border-border bg-transparent dark:bg-transparent px-3 text-sm font-normal text-foreground shadow-none hover:bg-accent dark:hover:bg-accent [&_svg:not([class*='size-'])]:size-3.5"
        >
          <span className="grid grid-cols-1 grid-rows-1 text-left [&>*]:col-start-1 [&>*]:row-start-1">
            {options.map((opt) => (
              <span
                key={opt}
                className={opt === value ? '' : 'invisible'}
                aria-hidden={opt === value ? undefined : true}
              >
                {sourceFilterLabel[opt]}
              </span>
            ))}
          </span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="flex min-w-40 flex-col gap-0 rounded-xl md:rounded-lg border border-border bg-card px-2 py-3"
      >
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt}
            onClick={() => onChange(opt)}
            className={`h-9 gap-1.5 rounded-lg md:rounded-md px-2 text-sm ${opt === value ? 'bg-accent' : ''}`}
          >
            <span className="flex-1">{sourceFilterLabel[opt]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const SkillsList = ({
  skills,
  activeSkill,
  isEnabled,
  onToggleEnabled,
  onCreate,
  onSelectSkill,
  onEdit,
  onDelete,
}: {
  skills: Skill[]
  activeSkill: string
  activeSource?: SkillSource
  isEnabled: (name: string) => boolean
  onToggleEnabled: (name: string, next: boolean) => void
  onCreate?: () => void
  onSelectSkill?: (name: string) => void
  onEdit?: (name?: string) => void
  onDelete?: (name?: string) => void
}) => {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [showWelcome, setShowWelcome] = useState(true)
  const { isMobile } = useIsMobile()
  const { toggleSidebar } = useSidebar()

  const visibleSkills = useMemo(
    () =>
      skills
        .filter((s) => sourceFilter === 'all' || s.source === sourceFilter)
        .slice()
        .sort((a, b) => Number(!isEnabled(a.name)) - Number(!isEnabled(b.name))),
    [skills, sourceFilter, isEnabled],
  )

  return (
    <section className="flex h-full w-full flex-col gap-3 border-r border-border/50 bg-background px-4 py-4 md:px-5 text-foreground md:w-[378px] md:shrink-0">
      <header className="relative flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isMobile && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
              aria-label="Open menu"
              className="size-8 -ml-1 rounded-md md:rounded-lg text-muted-foreground hover:text-foreground"
            >
              <Menu className="size-[var(--icon-size-lg)]" strokeWidth={1.5} />
            </Button>
          )}
          {!isMobile && <h1 className="text-xl leading-tight text-foreground">Skills</h1>}
        </div>
        {isMobile && (
          <h1 className="absolute left-1/2 -translate-x-1/2 text-xl leading-tight text-foreground pointer-events-none">
            Skills
          </h1>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-lg" aria-label="Add skill" className="size-8 rounded-md md:rounded-lg">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="flex w-56 flex-col gap-0 rounded-xl md:rounded-lg border border-border bg-card px-2 py-3"
          >
            <DropdownMenuItem
              asChild
              className="h-9 gap-1.5 md:rounded-md px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
            >
              <Link to="/marketplace?from=skills">
                <Store />
                Browse Marketplace
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onCreate}
              className="h-9 gap-1.5 md:rounded-md px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
            >
              <SquarePen />
              Write skill
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search Skills"
            className="h-9 rounded-lg border-border pl-9 text-sm placeholder:text-muted-foreground"
          />
        </div>
        <SourceFilterSelect value={sourceFilter} onChange={setSourceFilter} />
      </div>

      {showWelcome && (
        <div className="flex flex-col gap-2 rounded-xl md:rounded-lg border border-border bg-card p-2.5">
          <div className="flex items-start gap-2">
            <p className="flex-1 text-base leading-none text-foreground">Welcome! Try these starter skills.</p>
            <button
              type="button"
              aria-label="Dismiss welcome"
              onClick={() => setShowWelcome(false)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
          <p className="text-base leading-snug text-muted-foreground">
            Pinned skills{' '}
            <Pin
              size={14}
              className="inline-block align-[-2px] fill-current text-muted-foreground"
              aria-hidden="true"
            />{' '}
            appear above your chat input for quick access.
          </p>
          <p className="text-base leading-snug text-muted-foreground">
            You can only edit skills created inside the app (
            <Code size={14} className="inline-block align-[-2px] text-muted-foreground" aria-hidden="true" /> Local).
          </p>
        </div>
      )}

      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {visibleSkills.map((skill) => {
          const isActive = skill.name === activeSkill
          const enabled = isEnabled(skill.name)
          return (
            <li key={skill.name}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelectSkill?.(skill.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelectSkill?.(skill.name)
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
                      onCheckedChange={(next) => onToggleEnabled(skill.name, next)}
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
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:bg-foreground/10 aria-expanded:opacity-100"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={8}
                    className="flex w-56 flex-col gap-0 rounded-xl md:rounded-lg border border-border bg-card px-2 py-3"
                  >
                    {skill.source === 'local' && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit?.(skill.name)
                        }}
                        className="h-9 gap-1.5 md:rounded-md px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
                      >
                        <SquarePen />
                        Edit
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      asChild
                      className="h-9 gap-1.5 md:rounded-md px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
                    >
                      <Link to={`/?run=${encodeURIComponent(skill.name)}`}>
                        <Play />
                        Run in chat
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete?.(skill.name)
                      }}
                      className="h-9 gap-1.5 md:rounded-md px-2 text-sm [&_svg:not([class*='size-'])]:size-4"
                    >
                      <Trash2 />
                      {skill.source === 'local' ? 'Delete' : 'Uninstall'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
