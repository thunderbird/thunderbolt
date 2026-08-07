/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LucideIcon } from 'lucide-react'

/**
 * A command either navigates to a route (`to`) or runs an imperative
 * side effect (`run`). Exactly one variant applies per command.
 */
export type CommandAction = { to: string; state?: Record<string, unknown> } | { run: () => void | Promise<void> }

/** Logical grouping used to render section headers in the palette. */
export type CommandSection = 'navigation' | 'actions' | 'create'

/**
 * A single non-entity command row in the Cmd+K palette. Commands are a
 * static list filtered client-side by cmdk (they do NOT enter the FTS
 * index), so `title` and `keywords` drive matchability.
 */
export type PaletteCommand = {
  id: string
  title: string
  icon: LucideIcon
  section: CommandSection
  keywords?: string[]
  shortcut?: string
} & CommandAction

/**
 * Injected callbacks for commands that must open a modal owned by the
 * palette host rather than perform the action directly.
 */
export type UseCommandsOptions = {
  onSignOut: () => void
  onClearAllChats: () => void
}
