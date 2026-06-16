/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { AppLogo } from '@/components/app-logo'
import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { useWorkspacesQuery, type Workspace } from '@/dal'
import { useCanCreateWorkspace } from '@/hooks/use-can-create-workspace'
import { isDataUrlIcon } from '@/components/workspace/icon-utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { crossWorkspaceSubPath, toWorkspaceUrl, useActiveWorkspace } from '@/lib/active-workspace'
import { cn } from '@/lib/utils'
import { ChevronDown, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { CreateWorkspaceModal } from './create-workspace-modal'
import { InviteMembersModal } from './invite-members-modal'

const initialOf = (name: string): string => {
  const trimmed = name.trim()
  if (!trimmed) {
    return '?'
  }
  return trimmed[0].toUpperCase()
}

type WorkspaceAvatarProps = {
  workspace: Workspace
  className?: string
}

/**
 * 24×24 avatar for a workspace. Resolution order:
 * 1. `workspace.icon` set to a `data:` URL → render the uploaded image.
 * 2. `workspace.icon` set to plain text → render as emoji.
 * 3. Personal workspace with no icon → Thunderbolt `AppLogo` (home identity).
 * 4. Shared workspace with no icon → first initial on an accent-coloured square.
 */
const WorkspaceAvatar = ({ workspace, className }: WorkspaceAvatarProps) => {
  if (isDataUrlIcon(workspace.icon)) {
    return (
      <img
        src={workspace.icon}
        alt=""
        className={cn('size-6 rounded-md object-cover shrink-0', className)}
        aria-hidden="true"
      />
    )
  }
  if (workspace.icon) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-md bg-accent text-accent-foreground shrink-0',
          'size-6 text-base leading-none',
          className,
        )}
        aria-hidden="true"
      >
        {workspace.icon}
      </div>
    )
  }
  if (workspace.isPersonal === 1) {
    return <AppLogo size={24} className={cn('shrink-0', className)} />
  }
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-md bg-accent text-accent-foreground shrink-0',
        'size-6 text-[length:var(--font-size-xs)] font-semibold',
        className,
      )}
      aria-hidden="true"
    >
      {initialOf(workspace.name)}
    </div>
  )
}

type WorkspaceItemData = {
  workspace: Workspace
}

const toMenuItem = (workspace: Workspace): SearchableMenuItem<WorkspaceItemData> => ({
  id: workspace.id,
  label: workspace.name,
  icon: <WorkspaceAvatar workspace={workspace} />,
  data: { workspace },
})

const groupWorkspaces = (workspaces: Workspace[]): SearchableMenuGroup<WorkspaceItemData>[] => {
  const personal = workspaces.filter((w) => w.isPersonal === 1).map(toMenuItem)
  const shared = workspaces.filter((w) => w.isPersonal !== 1).map(toMenuItem)
  const groups: SearchableMenuGroup<WorkspaceItemData>[] = []
  if (personal.length > 0) {
    groups.push({ id: 'personal', items: personal })
  }
  if (shared.length > 0) {
    groups.push({ id: 'shared', label: 'Workspaces', items: shared })
  }
  return groups
}

export type WorkspaceSelectorProps = {
  /** When true, render the trigger as the avatar only (for the collapsed sidebar). */
  collapsed?: boolean
}

/**
 * Sidebar header trigger that lists every workspace the active user belongs
 * to. On select, swaps the `/w/<id>` prefix on the current URL — personal
 * workspaces become unprefixed (canonical), shared workspaces get the `/w/<id>`
 * prefix. Sub-path + search params are preserved so switching from
 * `/settings/preferences` lands on the same page under the new workspace.
 */
export const WorkspaceSelector = ({ collapsed = false }: WorkspaceSelectorProps) => {
  const { isMobile } = useIsMobile()
  const workspaces = useWorkspacesQuery()
  const active = useActiveWorkspace()
  const navigate = useNavigate()
  const location = useLocation()
  const canCreate = useCanCreateWorkspace()
  const e2eeEnabled = useConfigStore((state) => state.config.e2eeEnabled === true)
  const [createOpen, setCreateOpen] = useState(false)
  // After create-modal commits, hold the new workspace id so the invite modal
  // can target it; clearing this also closes the invite modal.
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null)

  const handleCreated = (workspaceId: string) => {
    setCreateOpen(false)
    // @todo Drop this E2EE branch once the encryption pipeline supports
    // multi-recipient envelopes and is workspace-aware (see THU-593). Until
    // then there's no point opening the invite step — the BE rejects pending
    // membership inserts under E2EE.
    if (e2eeEnabled) {
      navigate(`/w/${workspaceId}/`)
      return
    }
    setInviteWorkspaceId(workspaceId)
  }

  const handleInviteClose = () => {
    const id = inviteWorkspaceId
    setInviteWorkspaceId(null)
    if (id) {
      navigate(`/w/${id}/`)
    }
  }

  const groupedItems = useMemo(() => groupWorkspaces(workspaces), [workspaces])

  // The selector is rendered before the workspace gate completes; until the
  // active workspace resolves we still want a stable header layout, so render
  // a skeleton trigger that takes the same space.
  if (!active) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-2 h-[var(--touch-height-default)] rounded-md',
          collapsed && 'justify-center px-0',
        )}
      >
        <div className="size-[var(--icon-size-default)] rounded-md bg-accent/40" aria-hidden="true" />
        {!collapsed && <div className="flex-1 h-4 rounded bg-accent/40" />}
      </div>
    )
  }

  const handleChange = (_id: string, item: SearchableMenuItem<WorkspaceItemData>) => {
    const target = item.data?.workspace
    if (!target || target.id === active.id) {
      return
    }
    // Chat ids are per-workspace; carrying the current chat id across the
    // switch would land on Not Found. `crossWorkspaceSubPath` collapses
    // `/chats/<id>` to `/chats/new` for the target workspace.
    const subPath = crossWorkspaceSubPath(location.pathname)
    navigate(`${toWorkspaceUrl(target, subPath)}${location.search}`)
  }

  const renderTrigger = (_selected: SearchableMenuItem<WorkspaceItemData> | undefined, isOpen: boolean) => (
    <div
      className={cn(
        'flex items-center cursor-pointer transition-colors rounded-md text-[length:var(--font-size-body)]',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        isOpen && 'bg-sidebar-accent text-sidebar-accent-foreground',
        collapsed
          ? 'size-[var(--touch-height-sm)] justify-center'
          : 'gap-2 px-2 h-[var(--touch-height-default)] w-full',
      )}
    >
      <WorkspaceAvatar workspace={active} />
      {!collapsed && (
        <>
          <span className="truncate font-sans font-semibold text-[length:var(--font-size-sm)] leading-5 flex-1 text-left">
            {active.name}
          </span>
          <ChevronDown className="size-[var(--icon-size-default)] text-muted-foreground shrink-0" />
        </>
      )}
    </div>
  )

  const renderItem = (item: SearchableMenuItem<WorkspaceItemData>, isSelected: boolean) => {
    const isPersonal = item.data?.workspace.isPersonal === 1
    return (
      <div
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left cursor-pointer',
          isSelected ? 'bg-accent' : 'hover:bg-accent/50',
        )}
      >
        {item.icon}
        <span className="flex-1 truncate">{item.label}</span>
        {isPersonal && (
          <span className="text-muted-foreground text-[length:var(--font-size-xs)] uppercase tracking-wide">
            My Workspace
          </span>
        )}
      </div>
    )
  }

  const footer = canCreate ? (
    <button
      type="button"
      onClick={() => setCreateOpen(true)}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-[length:var(--font-size-body)]',
        'cursor-pointer transition-colors hover:bg-accent/50',
      )}
    >
      <span className="font-medium">Create workspace</span>
      <Plus className="size-[var(--icon-size-default)] text-muted-foreground" />
    </button>
  ) : undefined

  return (
    <>
      <SearchableMenu<WorkspaceItemData>
        items={groupedItems}
        value={active.id}
        onValueChange={handleChange}
        searchable={false}
        blurBackdrop
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        trigger={renderTrigger}
        renderItem={renderItem}
        width={280}
        maxHeight={400}
        footer={footer}
        triggerClassName={collapsed ? undefined : 'w-full'}
      />
      <CreateWorkspaceModal open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
      <InviteMembersModal
        open={inviteWorkspaceId !== null}
        workspaceId={inviteWorkspaceId}
        onClose={handleInviteClose}
      />
    </>
  )
}
