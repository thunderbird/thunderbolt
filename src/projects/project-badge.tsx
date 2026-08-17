/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * "You are in this project" marker for the chat header, sitting beside the agent
 * picker. Clicking it opens the project.
 *
 * Reads the id off the chat session (already there — it's what stamps the thread
 * row on first send) and resolves the name/icon from the live projects list, so
 * this costs no additional query and updates the instant the project is renamed
 * or its emoji changes.
 */

import { useNavigate } from 'react-router'

import { useChatStore } from '@/chats/chat-store'
import { mobileHeaderControlFillClass } from '@/components/ui/modal-styles'
import { useProjects } from '@/dal/projects'
import { cn } from '@/lib/utils'
import { ProjectIcon } from './project-icon'

/**
 * The badge for a given chat, or null when the chat has no project.
 *
 * `iconOnly` is the mobile presentation: a circle carrying just the project's
 * icon, styled as the agent circle it sits beside. There is no room for a name
 * there, and two labelled pills in a 3-column header would collide.
 */
export const ProjectBadge = ({
  chatThreadId,
  iconOnly = false,
  className,
}: {
  chatThreadId: string | null
  iconOnly?: boolean
  className?: string
}) => {
  const navigate = useNavigate()
  const projectId = useChatStore((state) => (chatThreadId ? state.sessions.get(chatThreadId)?.projectId : null))
  const projects = useProjects()

  const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined
  if (!project) {
    return null
  }

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={() => navigate(`/projects/${project.id}`)}
        aria-label={`In project: ${project.name}`}
        title={`In project: ${project.name}`}
        className={cn(
          // Matched to the agent selector's collapsed circle: same size token,
          // same resting fill, so the pair reads as one set of controls.
          'flex size-[var(--touch-height-lg)] shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors active:bg-muted-foreground/20',
          mobileHeaderControlFillClass,
          className,
        )}
      >
        <ProjectIcon icon={project.icon} className="size-[var(--icon-size-default)] text-[1.05rem]" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => navigate(`/projects/${project.id}`)}
      title={`In project: ${project.name}`}
      className={cn(
        // Matched to the agent selector's trigger, which it sits beside: same
        // height, `rounded-full`, and no chrome at rest — the background appears
        // on hover only. It previously read as a bordered card, which made the
        // two neighbouring controls look like different kinds of thing.
        'flex h-[var(--touch-height-sm)] min-w-0 max-w-[14rem] cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 text-[length:var(--font-size-body)] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground dark:hover:bg-secondary/50',
        className,
      )}
    >
      <ProjectIcon icon={project.icon} className="size-4 text-[0.9rem]" />
      <span className="truncate">{project.name}</span>
    </button>
  )
}
