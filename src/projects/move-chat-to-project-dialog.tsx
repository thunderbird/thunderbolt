/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pick the project a chat belongs to.
 *
 * The pointer path for this is dragging a chat onto a sidebar project row, but a
 * drag is not available everywhere — the sidebar's project rows are desktop-only,
 * and a touch drag competes with the list's own scrolling. This dialog is the
 * equivalent that works on every platform and with a keyboard, so project
 * membership is never reachable by gesture alone.
 *
 * Mobile gets a bottom sheet and desktop a dialog, the same split
 * `ConfirmActionDialog` uses.
 */

import { Trans, useLingui } from '@lingui/react/macro'
import { Check, FolderMinus, Search } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { MobileActionSheet } from '@/components/ui/mobile-action-sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useProjects } from '@/dal/projects'
import { cn } from '@/lib/utils'
import { ProjectIcon } from './project-icon'
import type { Project } from '@/types'

type MoveChatToProjectPickerProps = {
  open: boolean
  /** The account's projects. Passed in rather than read from the DAL here, so the
   *  picker's behaviour is testable without module-mocking `@/dal/projects` — a
   *  bun `mock.module` is installed worker-wide and would leak `useProjects` into
   *  every sibling test. `MoveChatToProjectDialog` supplies the live list. */
  projects: readonly Project[]
  /** The chat's current project, so it can be marked and offered for removal. */
  currentProjectId: string | null
  onOpenChange: (open: boolean) => void
  /** `null` clears the chat's project. */
  onSelect: (projectId: string | null) => void
}

/**
 * Above this many projects the list gets a search field. Below it, scanning is
 * faster than typing and the field is just noise.
 */
const searchableFrom = 8

const ProjectOptions = ({
  projects,
  currentProjectId,
  onSelect,
}: Pick<MoveChatToProjectPickerProps, 'projects' | 'currentProjectId' | 'onSelect'>) => {
  const { t } = useLingui()
  const [search, setSearch] = useState('')
  const term = search.trim().toLowerCase()
  const matches = term ? projects.filter((project) => project.name.toLowerCase().includes(term)) : projects

  if (projects.length === 0) {
    return (
      <p className="py-2 text-[length:var(--font-size-sm)] text-muted-foreground">
        <Trans>No projects yet. Create one from the Projects page, then move this chat into it.</Trans>
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* This is the path to a project the sidebar's capped drop zone can't reach,
          so on a long list it has to be searchable or it's no better than the drag. */}
      {projects.length >= searchableFrom && (
        <div className="relative shrink-0">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-[var(--icon-size-sm)] -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t`Search projects`}
            aria-label={t`Search projects`}
            className="pl-7"
          />
        </div>
      )}

      <div className="flex max-h-[50vh] min-h-0 flex-col gap-1 overflow-y-auto">
        {matches.length === 0 ? (
          <p className="py-2 text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>No matching projects.</Trans>
          </p>
        ) : (
          matches.map((project) => {
            const isCurrent = project.id === currentProjectId
            return (
              <Button
                key={project.id}
                variant="ghost"
                // Left-aligned rows rather than centered button labels: this is a
                // list, and `justify-start` keeps the icons in one column.
                className={cn('h-[var(--touch-height-lg)] shrink-0 justify-start gap-2 px-2', isCurrent && 'bg-accent')}
                aria-current={isCurrent}
                onClick={() => onSelect(project.id)}
              >
                <ProjectIcon icon={project.icon} className="size-[var(--icon-size-default)] text-[1.05rem]" />
                <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                {isCurrent && <Check className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground" />}
              </Button>
            )
          })
        )}

        {/* Only meaningful when the chat is in a project — you can't remove it from
            nothing. Outside the filter: it is not a project and shouldn't vanish
            when a search excludes every name. */}
        {currentProjectId !== null && (
          <Button
            variant="ghost"
            className="h-[var(--touch-height-lg)] shrink-0 justify-start gap-2 px-2 text-muted-foreground"
            onClick={() => onSelect(null)}
          >
            <FolderMinus className="size-[var(--icon-size-default)]" aria-hidden="true" />
            <span className="flex-1 text-left">
              <Trans>Remove from project</Trans>
            </span>
          </Button>
        )}
      </div>
    </div>
  )
}

/** The picker itself, given a project list. */
export const MoveChatToProjectPicker = ({
  open,
  projects,
  currentProjectId,
  onOpenChange,
  onSelect,
}: MoveChatToProjectPickerProps) => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const title = t`Move to project`
  const description = t`Chats in a project inherit its instructions.`

  // Selecting always dismisses: the sheet is a picker, not a settings surface.
  const handleSelect = (projectId: string | null) => {
    onOpenChange(false)
    onSelect(projectId)
  }

  if (isMobile) {
    return (
      <MobileActionSheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
        <ProjectOptions projects={projects} currentProjectId={currentProjectId} onSelect={handleSelect} />
      </MobileActionSheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ProjectOptions projects={projects} currentProjectId={currentProjectId} onSelect={handleSelect} />
      </DialogContent>
    </Dialog>
  )
}

/** Live-data wrapper: the picker for the current account's projects. */
export const MoveChatToProjectDialog = (props: Omit<MoveChatToProjectPickerProps, 'projects'>) => {
  const projects = useProjects()
  return <MoveChatToProjectPicker projects={projects} {...props} />
}
