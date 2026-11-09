/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AttachmentData, Model } from '@/types'

/** Label of the Quick Entry window, declared in `src-tauri/tauri.macos.conf.json`. */
export const quickEntryWindowLabel = 'quick-entry'

/** Label of the main app window, the only receiver of Quick Entry submissions. */
export const mainWindowLabel = 'main'

/** Emitted by the Quick Entry window when the user sends a prompt. */
export const quickEntrySubmitEvent = 'quick-entry:submit'

export type QuickEntrySubmitPayload = {
  prompt: string
  /** The chat to send to, or null for a new chat. */
  chatId: string | null
  /** The model the user picked for a new chat, or null to keep the one it starts on. */
  modelId: string | null
  /**
   * Pasted files, already stored in the IndexedDB both windows share (same
   * origin), so only the references cross, as in a composer send.
   */
  attachments: AttachmentData[]
}

/** Emitted by the Quick Entry window each time it opens, asking the main window what it can offer. */
export const quickEntryRequestOptionsEvent = 'quick-entry:request-options'

/** The main window's answer to `quickEntryRequestOptionsEvent`. */
export const quickEntryOptionsEvent = 'quick-entry:options'

/** A chat the prompt can be sent to, with its title already resolved for display. */
export type QuickEntryChat = {
  id: string
  title: string
}

export type QuickEntryOptionsPayload = {
  /**
   * Models for the picker, with any API key replaced by `redactedApiKey`.
   * Empty when a new chat would not run on the built-in agent, which hides the
   * picker, as the composer does.
   */
  models: Model[]
  selectedModelId: string | null
  /** Recent chats, most recently active first. */
  chats: QuickEntryChat[]
}

/**
 * Stands in for a model's API key in `QuickEntryOptionsPayload`. The picker only
 * needs to know a key exists (to flag models without one), so the key stays out
 * of the event. That is data minimisation, not isolation: the panel shares the
 * main window's origin and storage.
 */
export const redactedApiKey = 'redacted'
