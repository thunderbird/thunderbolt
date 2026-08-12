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
import { useProjects } from '@/dal/projects'
import { cn } from '@/lib/utils'
import { ProjectIcon } from './project-icon'

/** The badge for a given chat, or null when the chat has no project. */
export const ProjectBadge = ({ chatThreadId, className }: { chatThreadId: string | null; className?: string }) => {
  const navigate = useNavigate()
  const projectId = useChatStore((state) => (chatThreadId ? state.sessions.get(chatThreadId)?.projectId : null))
  const projects = useProjects()

  const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined
  if (!project) {
    return null
  }

  return (
    <button
      type="button"
      onClick={() => navigate(`/projects/${project.id}`)}
      title={`In project: ${project.name}`}
      className={cn(
        'flex h-[var(--touch-height-sm)] min-w-0 max-w-[14rem] cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[length:var(--font-size-sm)] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground dark:bg-input',
        className,
      )}
    >
      <ProjectIcon icon={project.icon} className="size-4 text-[0.9rem]" />
      <span className="truncate">{project.name}</span>
    </button>
  )
}
