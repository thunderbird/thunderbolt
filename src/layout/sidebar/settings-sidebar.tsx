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
import { useAuth } from '@/contexts'
import { useActiveWorkspaceMembership } from '@/hooks/use-active-workspace-membership'
import { useAgentsSettingsHidden } from '@/hooks/use-agents-settings-hidden'
import { stripWorkspacePrefix, useActiveWorkspace } from '@/lib/active-workspace'
// `Lock` is paired with the temporarily-hidden Permissions entry below — keep
// the import commented so re-enabling the menu is a one-spot uncomment.

import { ArrowLeft, Bot, Boxes, Cpu, Plug, Server, SlidersHorizontal, Smartphone, Users, Zap } from 'lucide-react'
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
  // Devices is a per-account, cross-device management surface — anonymous
  // sessions and unauthenticated boots have nothing meaningful to manage there.
  const { data: session } = useAuth().useSession()
  const isLoggedIn = !!session?.user && session.user.isAnonymous !== true
  const activeWorkspace = useActiveWorkspace()
  // `isAdmin` is currently only used by the commented-out Permissions entry
  // below — keep the call so re-enabling is a single comment-flip.

  const { isAdmin: _isAdmin } = useActiveWorkspaceMembership()
  // Members is visible to every member of a shared workspace — the page is
  // read-friendly without action permissions, and individual actions (invite /
  // change role / remove) gate themselves on the granular permission keys.
  // Always hidden in Personal Workspaces (Decision 25 — no members to manage).
  // The General settings page is reachable only via the per-workspace gear in
  // the workspace selector now, so this whole sidebar group collapses to just
  // Members; on Personal Workspaces it has no items, so we hide it entirely.
  const membersItemVisible = activeWorkspace?.isPersonal !== 1
  const workspaceGroupVisible = membersItemVisible
  // Permissions is implicitly admin-only — there is no configurable
  // meta-permission for editing the permissions grid itself.
  // Hidden for now (see commented JSX block below); kept here so re-enabling
  // is a one-spot revert.
  // const permissionsItemVisible = activeWorkspace?.isPersonal !== 1 && isAdmin && !e2eeEnabled
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
        <SidebarGroupLabel>Extensions</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
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
                onClick={() => onSettingsNavigate('/settings/providers')}
                tooltip="Providers"
                className="cursor-pointer"
                isActive={subPath.startsWith('/settings/providers')}
              >
                <Boxes className="size-4" />
                <span>Providers</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
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
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

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
            {isLoggedIn && (
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
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {workspaceGroupVisible && (
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
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
              {/* Permissions entry hidden — feature isn't ready for users yet.
                  Underlying page + permissions DAL/handlers stay intact for the
                  internal eng team via direct URL nav.
              {permissionsItemVisible && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => onSettingsNavigate('/settings/workspace/permissions')}
                    tooltip="Permissions"
                    className="cursor-pointer"
                    isActive={subPath === '/settings/workspace/permissions'}
                  >
                    <Lock className="size-4" />
                    <span>Permissions</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              */}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}

      <div className="flex-1" />

      <SidebarFooter />
    </SidebarContent>
  )
}
