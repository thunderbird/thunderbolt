/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read-only slide-in for one project, mirroring `SkillDetail`: selecting a row
 * shows what the project *has* without any editable controls, and the ⋯ menu is
 * the way through to editing it.
 *
 * Deliberately the project's *contents* — chats and artifacts — rather than its
 * settings. Instructions are what you edit, not what you browse, so they live in
 * the edit panel behind ⋯ → Edit; a panel opened by clicking a row should answer
 * "what's in here?".
 *
 * Read-only for the same reason: a panel full of live inputs invites accidental
 * edits while scanning the list.
 */

import dayjs from 'dayjs'
import '@/lib/dayjs'
import { LayoutTemplate, MessageCircle, MessageCirclePlus } from 'lucide-react'
import type { ReactNode } from 'react'

import { DetailDivider, DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { DetailActionsMenu, DetailEditDeleteMenuItems } from '@/components/settings/detail-actions-menu'
import { IconTile } from '@/components/settings/icon-tile'
import type { ProjectArtifact } from '@/dal/projects'
import type { Project } from '@/types'
import { ProjectIcon } from './project-icon'

/**
 * Copy for the delete confirmation. Lives with the panel because the panel owns
 * the affordance (⋯ → Delete); the list page renders the dialog.
 */
export const deleteProjectPrompt = {
  title: 'Delete this project?',
  description: 'Its instructions are removed. Chats in the project are kept and become ordinary chats.',
  confirmLabel: 'Delete project',
} as const

type ProjectDetailPanelProps = {
  project: Project
  chats: readonly { id: string; title: string | null }[]
  artifacts: readonly ProjectArtifact[]
  /** Switches this panel into the edit form. */
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
  /** Open one of the project's chats. */
  onOpenChat: (chatThreadId: string) => void
  /** Start a new chat inside this project. */
  onNewChat: () => void
}

/** A row that opens a chat. Navigable even though the panel is read-only —
 *  opening a chat isn't an edit, and it's the likeliest thing to want from here. */
const OpenChatRow = ({
  label,
  meta,
  icon,
  onClick,
}: {
  label: string
  meta?: string
  icon: ReactNode
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-base leading-snug hover:underline"
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {meta && <span className="shrink-0 text-[length:var(--font-size-xs)] text-muted-foreground">{meta}</span>}
  </button>
)

export const ProjectDetailPanel = ({
  project,
  chats,
  artifacts,
  onEdit,
  onDelete,
  onClose,
  onOpenChat,
  onNewChat,
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
    {/* The one action worth having here rather than behind ⋯ → Edit: starting a
        chat is what a project is *for*, and it isn't an edit. */}
    <Button variant="outline" size="sm" className="w-full gap-2" onClick={onNewChat}>
      <MessageCirclePlus className="size-[var(--icon-size-sm)]" aria-hidden="true" />
      New chat in this project
    </Button>

    <div className="flex flex-col gap-2">
      <DetailSectionTitle>Chats</DetailSectionTitle>
      {chats.length === 0 ? (
        <p className="text-base leading-snug text-muted-foreground">No chats yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {chats.map((chat) => (
            <li key={chat.id}>
              <OpenChatRow
                label={chat.title ?? 'Untitled chat'}
                icon={
                  <MessageCircle
                    className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                }
                onClick={() => onOpenChat(chat.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>

    <DetailDivider />

    <div className="flex flex-col gap-2">
      <DetailSectionTitle>Artifacts</DetailSectionTitle>
      {artifacts.length === 0 ? (
        <p className="text-base leading-snug text-muted-foreground">No artifacts yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <OpenChatRow
                label={artifact.title}
                meta={dayjs(artifact.createdAt).fromNow()}
                icon={
                  <LayoutTemplate
                    className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                }
                onClick={() => onOpenChat(artifact.chatThreadId)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  </DetailPanel>
)
