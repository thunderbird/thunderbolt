/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
  AudioLines,
  Bot,
  CheckSquare,
  Cpu,
  Plug,
  SlidersHorizontal,
  Smartphone,
  Terminal,
  Zap,
  type LucideIcon,
} from 'lucide-react'

/**
 * Experimental/build gate a navigation command depends on. `voice` and `tasks`
 * mirror their sidebar/route feature flags; `dev` mirrors `import.meta.env.DEV`.
 */
export type NavGate = 'voice' | 'tasks' | 'dev'

/** A route the Cmd+K palette can jump to. Pure data — no React, no hooks. */
export type NavigationCommand = {
  id: string
  /** Descriptor, not a string: this manifest is module-scope data, so a resolved
   *  string would freeze at the boot locale. `useCommands` resolves it. */
  title: MessageDescriptor
  icon: LucideIcon
  to: string
  keywords?: string[]
  gate?: NavGate
}

/**
 * The palette's navigation manifest: every settings/app route reachable from
 * the sidebar (`settings-sidebar.tsx` navGroups) plus the top-level routes in
 * `app.tsx`. Gated entries are dropped by {@link useCommands} when their flag
 * is off — the manifest itself stays a static, testable list.
 *
 * Icons are the same lucide glyphs the sidebar uses so the palette reads as the
 * same navigation surface.
 */
export const navigationCommands: NavigationCommand[] = [
  { id: 'agents', title: msg`All agents`, icon: Bot, to: '/settings/agents', keywords: ['agents'] },
  { id: 'skills', title: msg`Skills`, icon: Zap, to: '/settings/skills' },
  {
    id: 'connections',
    title: msg`Connections`,
    icon: Plug,
    to: '/settings/connections',
    keywords: ['mcp', 'servers', 'integrations', 'plugins'],
  },
  { id: 'models', title: msg`Models`, icon: Cpu, to: '/settings/models', keywords: ['llm'] },
  {
    id: 'voice',
    title: msg`Voice`,
    icon: AudioLines,
    to: '/settings/voice',
    keywords: ['audio', 'speech', 'tts'],
    gate: 'voice',
  },
  {
    id: 'preferences',
    title: msg`Preferences`,
    icon: SlidersHorizontal,
    to: '/settings/preferences',
    keywords: ['theme', 'appearance'],
  },
  { id: 'devices', title: msg`Devices`, icon: Smartphone, to: '/settings/devices', keywords: ['sync'] },
  { id: 'tasks', title: msg`Tasks`, icon: CheckSquare, to: '/tasks', keywords: ['todo'], gate: 'tasks' },
  { id: 'dev-settings', title: msg`Dev Settings`, icon: Terminal, to: '/settings/dev-settings', gate: 'dev' },
  { id: 'message-simulator', title: msg`Message Simulator`, icon: Terminal, to: '/message-simulator', gate: 'dev' },
]
