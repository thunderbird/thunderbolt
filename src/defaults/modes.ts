/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chatPrompt } from '@/ai/prompts/modes/chat'
import { researchPrompt } from '@/ai/prompts/modes/research'
import { searchPrompt } from '@/ai/prompts/modes/search'
import { hashValues } from '@/lib/utils'
import type { Mode } from '@/types'

/**
 * Compute hash of user-editable fields for a mode
 */
export const hashMode = (mode: Mode): string => {
  return hashValues([mode.name, mode.label, mode.icon, mode.systemPrompt, mode.isDefault, mode.order, mode.deletedAt])
}

/**
 * Default modes shipped with the application
 */
export const defaultModeChat: Mode = {
  id: 'mode-chat',
  name: 'chat',
  label: 'Chat',
  icon: 'message-square',
  systemPrompt: chatPrompt,
  isDefault: 1,
  order: 0,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultModeSearch: Mode = {
  id: 'mode-search',
  name: 'search',
  label: 'Search',
  icon: 'globe',
  systemPrompt: searchPrompt,
  isDefault: 0,
  order: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultModeResearch: Mode = {
  id: 'mode-research',
  name: 'research',
  label: 'Research',
  icon: 'microscope',
  systemPrompt: researchPrompt,
  isDefault: 0,
  order: 2,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

/**
 * Array of all default modes for iteration
 */
export const defaultModes: ReadonlyArray<Mode> = [defaultModeChat, defaultModeSearch, defaultModeResearch] as const

/**
 * Monotonic version of the shipped mode defaults. Bump every time `defaultModes`
 * changes in any way. Reconcile uses this as the ordering signal so multi-device
 * sync groups converge without ping-ponging (THU-637 pattern extended to modes
 * in THU-677): a device only overwrites existing rows when this bundled version
 * is strictly newer than the highest ever applied on this account.
 *
 * The paired snapshot test in `modes.test.ts` fails on any change to this
 * file's defaults without a matching version bump.
 */
export const defaultModesVersion = 1
