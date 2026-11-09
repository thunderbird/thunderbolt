/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { isMacDesktop } from '@/lib/platform'
import { showMainWindow } from '@/lib/tray'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'
import { useEffect, useEffectEvent } from 'react'
import { useNavigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { i18n } from '@/i18n'
import type { AttachmentData } from '@/types'
import {
  quickEntryOptionsEvent,
  type QuickEntryOptionsPayload,
  quickEntryRequestOptionsEvent,
  quickEntrySubmitEvent,
  type QuickEntrySubmitPayload,
  quickEntryWindowLabel,
} from './events'
import { applyQuickEntryModel, loadQuickEntryOptions } from './quick-entry-options'

type MainWindow = Pick<Window, 'show' | 'setSkipTaskbar' | 'setFocus' | 'listen' | 'emitTo'>

type QuickEntryListenerDependencies = {
  mainWindow?: MainWindow
  enabled?: boolean
  loadOptions?: typeof loadQuickEntryOptions
  applyModel?: typeof applyQuickEntryModel
}

/**
 * Router state that sends `quickEntryPrompt` and `quickEntryAttachments` once
 * the chat's composer is up. Consumed by `ChatPromptInput`. `newChatRequestId`
 * forces a fresh chat on `/chats/new`; an existing chat has no use for it.
 */
export type QuickEntryNavState = {
  quickEntryPrompt: string
  quickEntryAttachments: AttachmentData[]
  newChatRequestId?: string
}

/**
 * Serve the Quick Entry window from the main window, which owns the database:
 * answer its requests for models and chats, and send each submitted prompt to
 * the chat picked in the panel, or as the first message of a new chat on the
 * model picked there.
 */
export const useQuickEntryListener = ({
  mainWindow,
  enabled = isMacDesktop(),
  loadOptions = loadQuickEntryOptions,
  applyModel = applyQuickEntryModel,
}: QuickEntryListenerDependencies = {}) => {
  const navigate = useNavigate()
  const db = useDatabase()

  const handleSubmit = useEffectEvent(async ({ prompt, chatId, modelId, attachments }: QuickEntrySubmitPayload) => {
    const appWindow = mainWindow ?? getCurrentWindow()
    if (!chatId) {
      // Before navigating: the new chat reads the selected model as it hydrates.
      await applyModel(db, modelId)
    }
    await showMainWindow(appWindow)
    await appWindow.setFocus()
    if (chatId) {
      const state: QuickEntryNavState = { quickEntryPrompt: prompt, quickEntryAttachments: attachments }
      navigate(`/chats/${chatId}`, { state })
      return
    }
    const state: QuickEntryNavState = {
      quickEntryPrompt: prompt,
      quickEntryAttachments: attachments,
      newChatRequestId: uuidv7(),
    }
    navigate('/chats/new', { state })
  })

  const handleRequestOptions = useEffectEvent(async () => {
    const appWindow = mainWindow ?? getCurrentWindow()
    const options = await loadOptions(db, i18n)
    await appWindow.emitTo<QuickEntryOptionsPayload>(quickEntryWindowLabel, quickEntryOptionsEvent, options)
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    const appWindow = mainWindow ?? getCurrentWindow()
    const unlisteners = [
      appWindow.listen<QuickEntrySubmitPayload>(quickEntrySubmitEvent, ({ payload }) =>
        handleSubmit(payload).catch((error) => console.error('Failed to open the Quick Entry prompt:', error)),
      ),
      appWindow.listen(quickEntryRequestOptionsEvent, () =>
        handleRequestOptions().catch((error) => console.error('Failed to send Quick Entry options:', error)),
      ),
    ]
    return () => {
      for (const unlisten of unlisteners) {
        void unlisten.then((stop) => stop())
      }
    }
  }, [enabled, mainWindow])
}
