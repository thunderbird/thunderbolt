/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { themeIcons } from '@/components/theme-icons'
import { useSidebar } from '@/components/ui/sidebar'
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { useSettings } from '@/hooks/use-settings'
import { getDownloadUrl } from '@/lib/download-links'
import { getWebOsPlatform, isMacDesktop, isTauri, isWebDesktopPlatform } from '@/lib/platform'
import { trackEvent } from '@/lib/posthog'
import { useTheme, type Theme } from '@/lib/theme-provider'
import { Download, LogOut, MessageCirclePlus, PanelLeft, Trash2 } from 'lucide-react'
import { buildCreateCommands } from './create-commands'
import { navigationCommands, type NavGate } from './navigation'
import type { PaletteCommand, UseCommandsOptions } from './types'

const showAppDownloads = import.meta.env.VITE_SHOW_APP_DOWNLOADS === 'true'

const openExternal = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

const isMacPlatform = () => isMacDesktop() || getWebOsPlatform() === 'macos'

/** Resolved feature/build gates a navigation command can depend on. */
export type CommandFlags = { voice: boolean; tasks: boolean; dev: boolean }

const themeOptions: { theme: Theme; title: string }[] = [
  { theme: 'light', title: 'Set Light' },
  { theme: 'dark', title: 'Set Dark' },
  { theme: 'system', title: 'Use System' },
]

const gateOpen = (gate: NavGate | undefined, flags: CommandFlags): boolean => (gate === undefined ? true : flags[gate])

/**
 * Everything {@link buildCommands} needs, injected as plain values so the
 * assembler stays pure and unit-testable without React providers. Side effects
 * live in the injected handlers, not here.
 */
export type BuildCommandsDeps = {
  flags: CommandFlags
  showDownloadApp: boolean
  isMac: boolean
  onNewChat: () => void
  onSetTheme: (theme: Theme) => void
  onToggleSidebar: () => void
  onSignOut: () => void
  onClearAllChats: () => void
}

/**
 * Pure assembler for the palette's non-entity commands: gated navigation routes
 * followed by imperative actions. cmdk filters this list client-side against the
 * query, so `title`/`keywords` drive matchability — commands never enter FTS.
 */
export const buildCommands = (deps: BuildCommandsDeps): PaletteCommand[] => {
  const navCommands: PaletteCommand[] = navigationCommands
    .filter((command) => gateOpen(command.gate, deps.flags))
    .map(({ id, title, icon, to, keywords }) => ({ id, title, icon, keywords, section: 'navigation', to }))

  const themeCommands: PaletteCommand[] = themeOptions.map(({ theme, title }) => ({
    id: `theme-${theme}`,
    title,
    icon: themeIcons[theme],
    section: 'actions',
    keywords: ['theme', 'appearance'],
    run: () => deps.onSetTheme(theme),
  }))

  const downloadCommands: PaletteCommand[] = deps.showDownloadApp
    ? [
        {
          id: 'download-app',
          title: 'Download app',
          icon: Download,
          section: 'actions',
          keywords: ['install'],
          run: () => {
            openExternal(getDownloadUrl())
          },
        },
      ]
    : []

  const actionCommands: PaletteCommand[] = [
    ...themeCommands,
    {
      id: 'toggle-sidebar',
      title: 'Toggle sidebar',
      icon: PanelLeft,
      section: 'actions',
      shortcut: deps.isMac ? '⌘B' : 'Ctrl+B',
      run: deps.onToggleSidebar,
    },
    ...downloadCommands,
    {
      id: 'sign-out',
      title: 'Sign out',
      icon: LogOut,
      section: 'actions',
      keywords: ['logout', 'log out'],
      run: deps.onSignOut,
    },
    {
      id: 'clear-all-chats',
      title: 'Clear all chats',
      icon: Trash2,
      section: 'actions',
      keywords: ['delete', 'remove'],
      run: deps.onClearAllChats,
    },
  ]

  // "New chat" is a create action too, and the most common one — list it first
  // in the Create group ahead of the entity create commands.
  const newChatCommand: PaletteCommand = {
    id: 'new-chat',
    title: 'New chat',
    icon: MessageCirclePlus,
    section: 'create',
    keywords: ['new', 'create'],
    run: deps.onNewChat,
  }

  return [...navCommands, newChatCommand, ...buildCreateCommands(), ...actionCommands]
}

/**
 * Wires the shared app hooks into {@link buildCommands}. Every action delegates
 * to the same hook the sidebar uses — nothing here reimplements behaviour.
 */
export const useCommands = (opts: UseCommandsOptions): PaletteCommand[] => {
  const { experimentalFeatureVoice, experimentalFeatureTasks } = useSettings({
    experimental_feature_voice: false,
    experimental_feature_tasks: false,
  })
  const createNewChat = useCreateNewChat()
  const { setTheme } = useTheme()
  const { toggleSidebar, closeMobileSidebar } = useSidebar()

  return buildCommands({
    flags: {
      voice: experimentalFeatureVoice.value,
      tasks: experimentalFeatureTasks.value,
      dev: import.meta.env.DEV,
    },
    showDownloadApp: showAppDownloads && !isTauri() && isWebDesktopPlatform(),
    isMac: isMacPlatform(),
    // "New chat" navigates, so dismiss the mobile sidebar drawer first (no-op on
    // desktop / when closed) — the palette's `handleCommand` only closes it for
    // `to` commands, and this is a `run` command.
    onNewChat: async () => {
      await closeMobileSidebar()
      createNewChat()
    },
    onSetTheme: (theme) => {
      setTheme(theme)
      trackEvent('settings_theme_set', { theme })
    },
    // The palette shares the layout's SidebarProvider, so this hits the real
    // toggle — mobile drawer and desktop collapse alike.
    onToggleSidebar: toggleSidebar,
    onSignOut: opts.onSignOut,
    onClearAllChats: opts.onClearAllChats,
  })
}
