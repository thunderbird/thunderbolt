/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { selectMinimalMode, useConfigStore } from '@/api/config-store'
import { useAuth } from '@/contexts'
import { themeIcons } from '@/components/theme-icons'
import { useSidebar } from '@/components/ui/sidebar'
import { useCreateNewChat } from '@/hooks/use-create-new-chat'
import { useSettings } from '@/hooks/use-settings'
import { getDownloadUrl } from '@/lib/download-links'
import { getWebOsPlatform, isMacDesktop, isTauri, isWebDesktopPlatform } from '@/lib/platform'
import { trackEvent } from '@/lib/posthog'
import { useTheme, type Theme } from '@/lib/theme-provider'
import type { I18n, MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { Download, LogOut, MessageCirclePlus, PanelLeft, Trash2 } from 'lucide-react'
import { isMinimalModeHiddenPath } from '../registry'
import { buildCreateCommands } from './create-commands'
import { navigationCommands, type NavGate } from './navigation'
import type { PaletteCommand, UseCommandsOptions } from './types'

const showAppDownloads = import.meta.env.VITE_SHOW_APP_DOWNLOADS === 'true'

const openExternal = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

const isMacPlatform = () => isMacDesktop() || getWebOsPlatform() === 'macos'

/** Resolved feature/build gates a navigation command can depend on. */
export type CommandFlags = { voice: boolean; tasks: boolean; dev: boolean }

const themeOptions: { theme: Theme; title: MessageDescriptor }[] = [
  { theme: 'light', title: msg`Set Light` },
  { theme: 'dark', title: msg`Set Dark` },
  { theme: 'system', title: msg`Use System` },
]

const gateOpen = (gate: NavGate | undefined, flags: CommandFlags): boolean => (gate === undefined ? true : flags[gate])

/**
 * Everything {@link buildCommands} needs, injected as plain values so the
 * assembler stays pure and unit-testable without React providers. Side effects
 * live in the injected handlers, not here.
 */
export type BuildCommandsDeps = {
  /** Injected like every other dependency so the assembler stays pure — the
   *  command titles are module-scope descriptors that need resolving. */
  i18n: I18n
  flags: CommandFlags
  /** In minimal mode (see `selectMinimalMode`) there is no Settings section or
   *  Projects, so every `/settings/*` and Projects command is dropped. */
  minimalMode: boolean
  /** True for an anonymous session, which has nothing to sign out of. */
  isAnonymous: boolean
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
    .filter((command) => !(deps.minimalMode && isMinimalModeHiddenPath(command.to)))
    .map(({ id, title, icon, to, keywords }) => ({
      id,
      title: deps.i18n._(title),
      icon,
      keywords,
      section: 'navigation',
      to,
    }))

  const themeCommands: PaletteCommand[] = themeOptions.map(({ theme, title }) => ({
    id: `theme-${theme}`,
    title: deps.i18n._(title),
    icon: themeIcons[theme],
    section: 'actions',
    keywords: ['theme', 'appearance'],
    run: () => deps.onSetTheme(theme),
  }))

  const downloadCommands: PaletteCommand[] = deps.showDownloadApp
    ? [
        {
          id: 'download-app',
          title: deps.i18n._(msg`Download app`),
          icon: Download,
          section: 'actions',
          keywords: ['install'],
          run: () => {
            openExternal(getDownloadUrl())
          },
        },
      ]
    : []

  // An anonymous session has no account to leave (the sidebar treats it as
  // logged out), and signing out destroys it with no way back to its chats.
  // Real accounts keep Sign out in every mode: minimal mode hides the account
  // menu, so the palette is their only way out.
  const signOutCommands: PaletteCommand[] = deps.isAnonymous
    ? []
    : [
        {
          id: 'sign-out',
          title: deps.i18n._(msg`Sign out`),
          icon: LogOut,
          section: 'actions',
          keywords: ['logout', 'log out'],
          run: deps.onSignOut,
        },
      ]

  const actionCommands: PaletteCommand[] = [
    ...themeCommands,
    {
      id: 'toggle-sidebar',
      title: deps.i18n._(msg`Toggle sidebar`),
      icon: PanelLeft,
      section: 'actions',
      shortcut: deps.isMac ? '⌘B' : 'Ctrl+B',
      run: deps.onToggleSidebar,
    },
    ...downloadCommands,
    ...signOutCommands,
    {
      id: 'clear-all-chats',
      title: deps.i18n._(msg`Clear all chats`),
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
    title: deps.i18n._(msg`New chat`),
    icon: MessageCirclePlus,
    section: 'create',
    keywords: ['new', 'create'],
    run: deps.onNewChat,
  }

  // Every create command opens a Settings page, so they go with it.
  const createCommands = deps.minimalMode ? [] : buildCreateCommands(deps.i18n)

  return [...navCommands, newChatCommand, ...createCommands, ...actionCommands]
}

/**
 * Wires the shared app hooks into {@link buildCommands}. Every action delegates
 * to the same hook the sidebar uses — nothing here reimplements behaviour.
 */
export const useCommands = (opts: UseCommandsOptions): PaletteCommand[] => {
  const { i18n } = useLingui()
  const { experimentalFeatureVoice, experimentalFeatureTasks } = useSettings({
    experimental_feature_voice: false,
    experimental_feature_tasks: false,
  })
  const createNewChat = useCreateNewChat()
  const { setTheme } = useTheme()
  const { toggleSidebar, closeMobileSidebar } = useSidebar()
  const minimalMode = useConfigStore((state) => selectMinimalMode(state.config))
  const { data: session } = useAuth().useSession()

  return buildCommands({
    i18n,
    minimalMode,
    isAnonymous: session?.user?.isAnonymous === true,
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
