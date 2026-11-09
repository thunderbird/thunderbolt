/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type AttachmentStorage, useComposerAttachments } from '@/components/chat/use-composer-attachments'
import type { Model } from '@/types'
import { hide } from '@tauri-apps/api/app'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'
import { type KeyboardEvent, useEffect, useEffectEvent, useReducer, useRef, useState } from 'react'
import {
  mainWindowLabel,
  type QuickEntryChat,
  quickEntryOptionsEvent,
  type QuickEntryOptionsPayload,
  quickEntryRequestOptionsEvent,
  quickEntrySubmitEvent,
  type QuickEntrySubmitPayload,
} from './events'

export type QuickEntryWindow = Pick<Window, 'hide' | 'onFocusChanged' | 'emitTo' | 'listen'>

type QuickEntryDependencies = {
  quickEntryWindow?: QuickEntryWindow
  hideApp?: () => Promise<void>
  attachmentStorage?: AttachmentStorage
}

/** The picker whose list is open above the input; only one at a time. */
export type QuickEntryPicker = 'chat' | 'model'

type QuickEntryState = {
  prompt: string
  models: Model[]
  selectedModelId: string | null
  /**
   * Whether the user picked `selectedModelId`, rather than it being the model
   * the main window said a new chat starts on. Only a pick is sent: sending the
   * default would save it as `selected_model`, which counts as choosing the
   * built-in agent from then on.
   */
  modelPicked: boolean
  chats: QuickEntryChat[]
  /** The chat to send to; null is a new chat. */
  selectedChatId: string | null
  openPicker: QuickEntryPicker | null
  /** Pastes still being compressed and stored; their chips are not in `attachments` yet. */
  pendingPastes: number
}

type QuickEntryAction =
  | { type: 'setPrompt'; prompt: string }
  | { type: 'optionsLoaded'; payload: QuickEntryOptionsPayload }
  | { type: 'selectModel'; modelId: string }
  | { type: 'selectChat'; chatId: string | null }
  | { type: 'togglePicker'; picker: QuickEntryPicker }
  | { type: 'closePicker' }
  | { type: 'sent' }
  | { type: 'pasteStarted' }
  | { type: 'pasteSettled' }

const focusPrompt = (panel: HTMLElement | null) => panel?.querySelector('textarea')?.focus()

const initialState: QuickEntryState = {
  prompt: '',
  models: [],
  selectedModelId: null,
  modelPicked: false,
  chats: [],
  selectedChatId: null,
  openPicker: null,
  pendingPastes: 0,
}

const reducer = (state: QuickEntryState, action: QuickEntryAction): QuickEntryState => {
  switch (action.type) {
    case 'setPrompt':
      return { ...state, prompt: action.prompt }
    case 'optionsLoaded': {
      const { models, selectedModelId, chats } = action.payload
      // A chat deleted since the last open falls back to a new chat.
      const selectedChatId = chats.some(({ id }) => id === state.selectedChatId) ? state.selectedChatId : null
      return { ...state, models, selectedModelId, modelPicked: false, chats, selectedChatId }
    }
    case 'selectModel':
      return { ...state, selectedModelId: action.modelId, modelPicked: true, openPicker: null }
    case 'selectChat':
      return { ...state, selectedChatId: action.chatId, openPicker: null }
    case 'togglePicker':
      return { ...state, openPicker: state.openPicker === action.picker ? null : action.picker }
    case 'closePicker':
      return { ...state, openPicker: null }
    case 'sent':
      return { ...state, prompt: '', openPicker: null }
    case 'pasteStarted':
      return { ...state, pendingPastes: state.pendingPastes + 1 }
    case 'pasteSettled':
      return { ...state, pendingPastes: state.pendingPastes - 1 }
  }
}

/**
 * State for the Quick Entry window: the prompt text, the chat and model
 * pickers, sending the prompt to the main window, and dismissing the panel.
 *
 * The model picker only applies to a new chat: an existing chat keeps the model
 * it was already on, so the panel offers no models once a chat is picked.
 *
 * Pasted files go through the composer's own attachment handling, so they are
 * checked, compressed and stored exactly as a paste in the app would be; the
 * send then carries only their references.
 *
 * The panel is created hidden at launch and reused, so it never unmounts.
 * Focus changes stand in for "opened" and "closed": gaining focus means the tray
 * showed it, so the textarea is focused and the chats and models are asked for
 * again (they live in the main window's database and may have changed); losing focus
 * means the user clicked away, so it hides, like Spotlight.
 *
 * Escape also hides the app. Hiding only the panel leaves the app active, and
 * macOS then brings its next window forward, the main window, when the user
 * meant to go back to what they were doing.
 */
export const useQuickEntryState = ({
  quickEntryWindow,
  hideApp = hide,
  attachmentStorage,
}: QuickEntryDependencies = {}) => {
  const [appWindow] = useState<QuickEntryWindow>(() => quickEntryWindow ?? getCurrentWindow())
  const [state, dispatch] = useReducer(reducer, initialState)
  const panelRef = useRef<HTMLFormElement>(null)
  const submittingRef = useRef(false)
  const { attachments, setAttachments, attachError, setAttachError, handlePaste, removeAttachment } =
    useComposerAttachments({ acceptsAttachments: true, storage: attachmentStorage })

  useEffect(() => {
    const unlisteners = [
      appWindow.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          focusPrompt(panelRef.current)
          void appWindow.emitTo(mainWindowLabel, quickEntryRequestOptionsEvent)
          return
        }
        dispatch({ type: 'closePicker' })
        void appWindow.hide()
      }),
      appWindow.listen<QuickEntryOptionsPayload>(quickEntryOptionsEvent, ({ payload }) =>
        dispatch({ type: 'optionsLoaded', payload }),
      ),
    ]
    return () => {
      for (const unlisten of unlisteners) {
        void unlisten.then((stop) => stop())
      }
    }
  }, [appWindow])

  const models = state.selectedChatId ? [] : state.models
  const selectedModel = models.find((model) => model.id === state.selectedModelId) ?? null
  const selectedChat = state.chats.find((chat) => chat.id === state.selectedChatId) ?? null

  // A send while a paste is still being stored would go out without it, and its
  // chip would land in the hidden panel, to reappear on the next open.
  const canSubmit = (state.prompt.trim().length > 0 || attachments.length > 0) && state.pendingPastes === 0

  const handlePanelPaste = (event: Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>) => {
    const adding = handlePaste(event)
    if (!adding) {
      return
    }
    dispatch({ type: 'pasteStarted' })
    void adding.finally(() => dispatch({ type: 'pasteSettled' }))
  }

  // A paste anywhere in the panel attaches its files, not only one into the
  // textarea: after a click on a chip or the logo, focus has left it. The
  // textarea's own handler runs first and claims the paste with
  // `preventDefault`, so this skips those rather than attaching twice.
  const handleWindowPaste = useEffectEvent((event: ClipboardEvent) => {
    if (!event.defaultPrevented) {
      handlePanelPaste(event)
    }
  })

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => handleWindowPaste(event)
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const submit = async () => {
    // A held Enter repeats while the emit is in flight; without this each
    // repeat would send the prompt again (and start another new chat).
    if (!canSubmit || submittingRef.current) {
      return
    }
    submittingRef.current = true
    try {
      await appWindow.emitTo<QuickEntrySubmitPayload>(mainWindowLabel, quickEntrySubmitEvent, {
        prompt: state.prompt.trim(),
        chatId: selectedChat?.id ?? null,
        modelId: state.modelPicked ? (selectedModel?.id ?? null) : null,
        attachments,
      })
      dispatch({ type: 'sent' })
      // The stored files now belong to the message being sent, so only the chips go.
      setAttachments([])
      setAttachError(null)
      await appWindow.hide()
    } finally {
      submittingRef.current = false
    }
  }

  const dismiss = async () => {
    await appWindow.hide()
    await hideApp()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Escape') {
      return
    }
    event.preventDefault()
    if (state.openPicker) {
      dispatch({ type: 'closePicker' })
      return
    }
    void dismiss()
  }

  return {
    prompt: state.prompt,
    setPrompt: (prompt: string) => dispatch({ type: 'setPrompt', prompt }),
    models,
    selectedModel,
    selectModel: (modelId: string) => {
      dispatch({ type: 'selectModel', modelId })
      focusPrompt(panelRef.current)
    },
    chats: state.chats,
    selectedChat,
    selectChat: (chatId: string | null) => {
      dispatch({ type: 'selectChat', chatId })
      focusPrompt(panelRef.current)
    },
    openPicker: state.openPicker,
    togglePicker: (picker: QuickEntryPicker) => dispatch({ type: 'togglePicker', picker }),
    closePicker: () => {
      dispatch({ type: 'closePicker' })
      focusPrompt(panelRef.current)
    },
    attachments,
    attachError,
    handlePaste: handlePanelPaste,
    removeAttachment,
    canSubmit,
    submit,
    handleKeyDown,
    panelRef,
  }
}
