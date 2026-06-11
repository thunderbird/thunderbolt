/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarFooter } from '@/components/sidebar-footer'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar'
import { useActiveWorkspaceMembership } from '@/hooks/use-active-workspace-membership'
import { useAgentsSettingsHidden } from '@/hooks/use-agents-settings-hidden'
import { useWorkspacePermission } from '@/hooks/use-workspace-permission'
import { stripWorkspacePrefix, useActiveWorkspace } from '@/lib/active-workspace'
import { ArrowLeft, Bot, Building2, Cpu, Plug, Server, SlidersHorizontal, Smartphone, Users, Zap } from 'lucide-react'
import { useLocation } from 'react-router'
import { SidebarHeader } from './sidebar-header'

type SettingsSidebarContentProps = {
  onBackClick: () => void
  onSettingsNavigate: (path: string) => void
  /** Test seam — production omits; the hook falls back to `isTauri()`. Lets
   *  tests exercise Tauri Standalone vs. Hosted code paths without mocking
   *  the shared `@/lib/platform` module (which would leak across files —
   *  see `docs/development/testing.md`). */
  isStandalone?: () => boolean
}

export const SettingsSidebarContent = ({
  onBackClick,
  onSettingsNavigate,
  isStandalone,
}: SettingsSidebarContentProps) => {
  const { toggleSidebar } = useSidebar()
  const location = useLocation()
  const agentsHidden = useAgentsSettingsHidden({ isStandalone })
  const activeWorkspace = useActiveWorkspace()
  const { isAdmin } = useActiveWorkspaceMembership()
  // General — and later Permissions — are hidden for shared-workspace members
  // per Decision 25 (hide-not-disable). Personal is treated as admin-equivalent
  // for nav purposes; the page renders read-only.
  const workspaceAdminItemsVisible = activeWorkspace?.isPersonal === 1 || isAdmin
  // Members visibility follows the configurable `manage_members` permission and
  // is always hidden in Personal Workspaces (Decision 25 — personal can't manage
  // members in v1).
  const { isAllowed: canManageMembers } = useWorkspacePermission('manage_members')
  const membersItemVisible = activeWorkspace?.isPersonal !== 1 && canManageMembers
  // `isActive` highlighting reads the sub-path so the same matching rules work
  // for both personal (`/settings/...`) and shared (`/w/<id>/settings/...`) URLs.
  const subPath = stripWorkspacePrefix(location.pathname)

  return (
    <SidebarContent className="flex flex-col h-full">
      <SidebarHeader onToggle={toggleSidebar} />

      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onBackClick} tooltip="Back to Chat" className="cursor-pointer">
                <ArrowLeft className="size-4" />
                <span>Back</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarSeparator className="m-0" />

      <SidebarGroup>
        <SidebarGroupLabel>Account Settings</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/preferences')}
                tooltip="Preferences"
                className="cursor-pointer"
                isActive={subPath === '/settings/preferences'}
              >
                <SlidersHorizontal className="size-4" />
                <span>Preferences</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/integrations')}
                tooltip="Integrations"
                className="cursor-pointer"
                isActive={subPath === '/settings/integrations'}
              >
                <Plug className="size-4" />
                <span>Integrations</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/devices')}
                tooltip="Devices"
                className="cursor-pointer"
                isActive={subPath === '/settings/devices'}
              >
                <Smartphone className="size-4" />
                <span>Devices</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="flex-1">
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {workspaceAdminItemsVisible && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => onSettingsNavigate('/settings/workspace/general')}
                  tooltip="General"
                  className="cursor-pointer"
                  isActive={subPath === '/settings/workspace/general'}
                >
                  <Building2 className="size-4" />
                  <span>General</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {membersItemVisible && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => onSettingsNavigate('/settings/workspace/members')}
                  tooltip="Members"
                  className="cursor-pointer"
                  isActive={subPath === '/settings/workspace/members'}
                >
                  <Users className="size-4" />
                  <span>Members</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/models')}
                tooltip="Models"
                className="cursor-pointer"
                isActive={subPath.startsWith('/settings/models')}
              >
                <Cpu className="size-4" />
                <span>Models</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/mcp-servers')}
                tooltip="MCP Servers"
                className="cursor-pointer"
                isActive={subPath === '/settings/mcp-servers'}
              >
                <Server className="size-4" />
                <span>MCP Servers</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {!agentsHidden && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => onSettingsNavigate('/settings/agents')}
                  tooltip="Agents"
                  className="cursor-pointer"
                  isActive={subPath === '/settings/agents'}
                >
                  <Bot className="size-4" />
                  <span>Agents</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onSettingsNavigate('/settings/skills')}
                tooltip="Skills"
                className="cursor-pointer"
                isActive={subPath === '/settings/skills'}
              >
                <Zap className="size-4" />
                <span>Skills</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarFooter />
    </SidebarContent>
  )
}
