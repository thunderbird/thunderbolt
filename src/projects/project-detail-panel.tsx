/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read-only slide-in for one project, mirroring `SkillDetail`: selecting a row
 * shows what the project *is* without any editable controls, and the ⋯ menu is
 * the way through to the editable page.
 *
 * Deliberately a summary, not a mirror of the project page. It shows
 * instructions and chats only — knowledge, assistant memory, and artifacts live
 * behind ⋯ → Edit. A panel opened by browsing should be glanceable; reproducing
 * every section here would make it a second, weaker copy of the full page.
 *
 * Read-only for the same reason: a panel full of live inputs invites accidental
 * edits while scanning the list.
 */

import { MessageCircle } from 'lucide-react'

import { DetailDivider, DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { DetailActionsMenu, DetailEditDeleteMenuItems } from '@/components/settings/detail-actions-menu'
import { IconTile } from '@/components/settings/icon-tile'
import type { Project } from '@/types'
import { ProjectIcon } from './project-icon'

type ProjectDetailPanelProps = {
  project: Project
  chats: readonly { id: string; title: string | null }[]
  /** Opens the editable project page — the only route to everything not shown here. */
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
  /** Open one of the project's chats. */
  onOpenChat: (chatThreadId: string) => void
}

export const ProjectDetailPanel = ({
  project,
  chats,
  onEdit,
  onDelete,
  onClose,
  onOpenChat,
}: ProjectDetailPanelProps) => (
  <DetailPanel
    icon={
      <IconTile>
        <ProjectIcon icon={project.icon} className="size-5 text-[1.15rem]" />
      </IconTile>
    }
    title={project.name}
    subtitle={project.description ?? undefined}
    actions={
      <DetailActionsMenu>
        <DetailEditDeleteMenuItems onEdit={onEdit} onDelete={onDelete} />
      </DetailActionsMenu>
    }
    onClose={onClose}
  >
    <div className="flex shrink-0 flex-col gap-2">
      <DetailSectionTitle>Instructions</DetailSectionTitle>
      {project.instructions?.trim() ? (
        <p className="whitespace-pre-wrap text-base leading-snug text-foreground">{project.instructions}</p>
      ) : (
        <p className="text-base leading-snug text-muted-foreground">No instructions yet.</p>
      )}
    </div>

    <DetailDivider />

    <div className="flex flex-col gap-2">
      <DetailSectionTitle>Chats</DetailSectionTitle>
      {chats.length === 0 ? (
        <p className="text-base leading-snug text-muted-foreground">No chats yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {chats.map((chat) => (
            <li key={chat.id}>
              {/* Navigable even though the panel is read-only: opening a chat
                  isn't an edit, and it's the most likely thing to want from here. */}
              <button
                type="button"
                onClick={() => onOpenChat(chat.id)}
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-base leading-snug hover:underline"
              >
                <MessageCircle
                  className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{chat.title ?? 'Untitled chat'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  </DetailPanel>
)
