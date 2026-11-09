/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent } from 'react'
import type { Model } from '@/types'
import {
  mainWindowLabel,
  type QuickEntryOptionsPayload,
  quickEntryOptionsEvent,
  quickEntryRequestOptionsEvent,
  quickEntrySubmitEvent,
} from './events'
import { type QuickEntryWindow, useQuickEntryState } from './use-quick-entry-state'

const createWindow = () => {
  let onFocus: ((event: { payload: boolean }) => void) | null = null
  let onOptions: ((event: { payload: QuickEntryOptionsPayload }) => void) | null = null
  const unlisten = mock(() => {})
  const quickEntryWindow = {
    hide: mock(() => Promise.resolve()),
    emitTo: mock((_target: string, _event: string, _payload?: unknown) => Promise.resolve()),
    onFocusChanged: mock((handler: (event: { payload: boolean }) => void) => {
      onFocus = handler
      return Promise.resolve(unlisten)
    }),
    listen: mock((event: string, handler: (event: { payload: QuickEntryOptionsPayload }) => void) => {
      if (event === quickEntryOptionsEvent) {
        onOptions = handler
      }
      return Promise.resolve(unlisten)
    }),
  }
  const setFocused = (focused: boolean) => onFocus?.({ payload: focused })
  const receiveOptions = (payload: QuickEntryOptionsPayload) => onOptions?.({ payload })
  return { quickEntryWindow, setFocused, receiveOptions, unlisten }
}

const model = (id: string) => ({ id, name: `Model ${id}` }) as Model

const options: QuickEntryOptionsPayload = {
  models: [model('a'), model('b')],
  selectedModelId: 'a',
  chats: [
    { id: 'chat-1', title: 'Trip plans' },
    { id: 'chat-2', title: 'Recipes' },
  ],
}

/** In-memory stand-in for the IndexedDB blob store, injected rather than module-mocked. */
const createAttachmentStorage = () => {
  const files = new Map<string, unknown>()
  return {
    files,
    putAttachment: async (file: { id: string }) => {
      files.set(file.id, file)
    },
    deleteAttachment: async (id: string) => {
      files.delete(id)
    },
  }
}

const render = () => {
  const fake = createWindow()
  const hideApp = mock(() => Promise.resolve())
  const attachmentStorage = createAttachmentStorage()
  const hook = renderHook(() =>
    useQuickEntryState({
      quickEntryWindow: fake.quickEntryWindow as unknown as QuickEntryWindow,
      hideApp,
      attachmentStorage,
    }),
  )
  return { ...fake, ...hook, hideApp, attachmentStorage }
}

const keyDown = (key: string) =>
  ({ key, preventDefault: mock(() => {}) }) as unknown as KeyboardEvent<HTMLTextAreaElement>

describe('useQuickEntryState', () => {
  it('sends the trimmed prompt to the main window, then clears and hides', async () => {
    const { result, quickEntryWindow, hideApp } = render()
    act(() => result.current.setPrompt('  Plan my week  '))

    await act(() => result.current.submit())

    expect(quickEntryWindow.emitTo).toHaveBeenCalledWith(mainWindowLabel, quickEntrySubmitEvent, {
      prompt: 'Plan my week',
      chatId: null,
      modelId: null,
      attachments: [],
    })
    expect(result.current.prompt).toBe('')
    expect(quickEntryWindow.hide).toHaveBeenCalledTimes(1)
    expect(hideApp).not.toHaveBeenCalled()
  })

  it('sends once while a send is still in flight, so a held Enter does not repeat it', async () => {
    const { result, quickEntryWindow } = render()
    const emit = Promise.withResolvers<void>()
    quickEntryWindow.emitTo.mockImplementationOnce(() => emit.promise)
    act(() => result.current.setPrompt('hi'))

    const first = result.current.submit()
    await act(() => result.current.submit())
    emit.resolve()
    await act(() => first)

    expect(quickEntryWindow.emitTo).toHaveBeenCalledTimes(1)
  })

  it('sends nothing for a blank prompt', async () => {
    const { result, quickEntryWindow } = render()
    act(() => result.current.setPrompt('   '))

    await act(() => result.current.submit())

    expect(quickEntryWindow.emitTo).not.toHaveBeenCalled()
    expect(quickEntryWindow.hide).not.toHaveBeenCalled()
  })

  it('hides the panel and the app on Escape, keeping the typed text', async () => {
    const { result, quickEntryWindow, hideApp } = render()
    act(() => result.current.setPrompt('draft'))

    await act(async () => result.current.handleKeyDown(keyDown('Escape')))

    expect(quickEntryWindow.hide).toHaveBeenCalledTimes(1)
    expect(hideApp).toHaveBeenCalledTimes(1)
    expect(result.current.prompt).toBe('draft')
  })

  it('ignores other keys', () => {
    const { result, quickEntryWindow } = render()

    act(() => result.current.handleKeyDown(keyDown('Enter')))

    expect(quickEntryWindow.hide).not.toHaveBeenCalled()
  })

  it('hides only the panel when it loses focus, leaving the app where the user clicked', () => {
    const { setFocused, quickEntryWindow, hideApp } = render()

    act(() => setFocused(false))

    expect(quickEntryWindow.hide).toHaveBeenCalledTimes(1)
    expect(hideApp).not.toHaveBeenCalled()
  })

  it('focuses the textarea when the panel gains focus', () => {
    const { result, setFocused, quickEntryWindow } = render()
    const panel = document.createElement('form')
    const textarea = document.createElement('textarea')
    panel.appendChild(textarea)
    document.body.appendChild(panel)
    result.current.panelRef.current = panel

    act(() => setFocused(true))

    expect(document.activeElement).toBe(textarea)
    expect(quickEntryWindow.hide).not.toHaveBeenCalled()
    panel.remove()
  })

  it('stops listening for focus changes on unmount', async () => {
    const { unmount, unlisten } = render()

    unmount()
    await act(() => Promise.resolve())

    expect(unlisten).toHaveBeenCalledTimes(2)
  })

  it('asks the main window for chats and models each time the panel opens', () => {
    const { setFocused, quickEntryWindow } = render()

    act(() => setFocused(true))

    expect(quickEntryWindow.emitTo).toHaveBeenCalledWith(mainWindowLabel, quickEntryRequestOptionsEvent)
  })

  describe('model picker', () => {
    it('selects the model the main window says a new chat would start on', () => {
      const { result, receiveOptions } = render()

      act(() => receiveOptions(options))

      expect(result.current.models).toHaveLength(2)
      expect(result.current.selectedModel?.id).toBe('a')
    })

    it('sends the picked model with the prompt and closes the list', async () => {
      const { result, receiveOptions, quickEntryWindow } = render()
      act(() => receiveOptions(options))
      act(() => result.current.togglePicker('model'))

      act(() => result.current.selectModel('b'))
      act(() => result.current.setPrompt('hi'))
      await act(() => result.current.submit())

      expect(result.current.openPicker).toBeNull()
      expect(quickEntryWindow.emitTo).toHaveBeenCalledWith(mainWindowLabel, quickEntrySubmitEvent, {
        prompt: 'hi',
        chatId: null,
        modelId: 'b',
        attachments: [],
      })
    })

    it('sends no model when the user kept the one a new chat starts on', async () => {
      const { result, receiveOptions, quickEntryWindow } = render()
      act(() => receiveOptions(options))

      act(() => result.current.setPrompt('hi'))
      await act(() => result.current.submit())

      expect(quickEntryWindow.emitTo).toHaveBeenCalledWith(mainWindowLabel, quickEntrySubmitEvent, {
        prompt: 'hi',
        chatId: null,
        modelId: null,
        attachments: [],
      })
    })

    it('closes the list on Escape instead of dismissing the panel', () => {
      const { result, receiveOptions, quickEntryWindow, hideApp } = render()
      act(() => receiveOptions(options))
      act(() => result.current.togglePicker('model'))

      act(() => result.current.handleKeyDown(keyDown('Escape')))

      expect(result.current.openPicker).toBeNull()
      expect(quickEntryWindow.hide).not.toHaveBeenCalled()
      expect(hideApp).not.toHaveBeenCalled()
    })

    it('closes the list when the panel loses focus, so it reopens collapsed', () => {
      const { result, receiveOptions, setFocused } = render()
      act(() => receiveOptions(options))
      act(() => result.current.togglePicker('model'))

      act(() => setFocused(false))

      expect(result.current.openPicker).toBeNull()
    })
  })

  describe('chat picker', () => {
    it('starts on a new chat', () => {
      const { result, receiveOptions } = render()

      act(() => receiveOptions(options))

      expect(result.current.selectedChat).toBeNull()
      expect(result.current.chats).toHaveLength(2)
    })

    it('sends to the picked chat, without a model: an existing chat keeps its own', async () => {
      const { result, receiveOptions, quickEntryWindow } = render()
      act(() => receiveOptions(options))

      act(() => result.current.selectChat('chat-2'))
      act(() => result.current.setPrompt('hi'))
      await act(() => result.current.submit())

      expect(quickEntryWindow.emitTo).toHaveBeenCalledWith(mainWindowLabel, quickEntrySubmitEvent, {
        prompt: 'hi',
        chatId: 'chat-2',
        modelId: null,
        attachments: [],
      })
    })

    it('returns focus to the prompt after a pick', () => {
      const { result, receiveOptions } = render()
      const panel = document.createElement('form')
      const textarea = document.createElement('textarea')
      panel.appendChild(textarea)
      document.body.appendChild(panel)
      result.current.panelRef.current = panel
      act(() => receiveOptions(options))

      act(() => result.current.selectChat('chat-2'))

      expect(document.activeElement).toBe(textarea)
      panel.remove()
    })

    it('hides the model picker while an existing chat is picked, and brings it back for a new chat', () => {
      const { result, receiveOptions } = render()
      act(() => receiveOptions(options))

      act(() => result.current.selectChat('chat-1'))
      expect(result.current.models).toHaveLength(0)

      act(() => result.current.selectChat(null))
      expect(result.current.models).toHaveLength(2)
    })

    it('opens one picker at a time', () => {
      const { result, receiveOptions } = render()
      act(() => receiveOptions(options))

      act(() => result.current.togglePicker('chat'))
      act(() => result.current.togglePicker('model'))

      expect(result.current.openPicker).toBe('model')
    })

    it('keeps the picked chat across opens, and falls back to a new chat once it is gone', () => {
      const { result, receiveOptions } = render()
      act(() => receiveOptions(options))
      act(() => result.current.selectChat('chat-1'))

      act(() => receiveOptions(options))
      expect(result.current.selectedChat?.id).toBe('chat-1')

      act(() => receiveOptions({ ...options, chats: [{ id: 'chat-2', title: 'Recipes' }] }))
      expect(result.current.selectedChat).toBeNull()
    })
  })

  describe('pasted files', () => {
    /** A paste carrying one image, in the shape `handlePaste` reads. */
    const pasteImage = () => {
      const file = new File(['png-bytes'], '', { type: 'image/png' })
      return {
        clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] },
        preventDefault: mock(() => {}),
      } as unknown as ReactClipboardEvent<HTMLTextAreaElement>
    }

    it('stores a pasted image locally and keeps only a reference to it', async () => {
      const { result, attachmentStorage } = render()

      act(() => result.current.handlePaste(pasteImage()))
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(result.current.attachments).toHaveLength(1)
      const [{ localFileId, mimeType }] = result.current.attachments
      expect(mimeType).toBe('image/png')
      expect(attachmentStorage.files.has(localFileId)).toBe(true)
    })

    it('sends an image with no text, then clears the chips', async () => {
      const { result, quickEntryWindow } = render()
      act(() => result.current.handlePaste(pasteImage()))
      await act(async () => {
        await getClock().runAllAsync()
      })
      const [attachment] = result.current.attachments

      expect(result.current.canSubmit).toBe(true)
      await act(() => result.current.submit())

      expect(quickEntryWindow.emitTo).toHaveBeenCalledWith(mainWindowLabel, quickEntrySubmitEvent, {
        prompt: '',
        chatId: null,
        modelId: null,
        attachments: [attachment],
      })
      expect(result.current.attachments).toHaveLength(0)
    })

    it('holds the send until a pasted image is stored, so it goes out with it', async () => {
      const { result, quickEntryWindow, attachmentStorage } = render()
      const stored = Promise.withResolvers<void>()
      attachmentStorage.putAttachment = async () => stored.promise
      act(() => result.current.setPrompt('look at this'))
      act(() => result.current.handlePaste(pasteImage()))

      expect(result.current.canSubmit).toBe(false)
      await act(() => result.current.submit())
      expect(quickEntryWindow.emitTo).not.toHaveBeenCalled()

      await act(async () => {
        stored.resolve()
        await getClock().runAllAsync()
      })
      expect(result.current.canSubmit).toBe(true)
      const [attachment] = result.current.attachments
      await act(() => result.current.submit())

      expect(quickEntryWindow.emitTo).toHaveBeenCalledWith(mainWindowLabel, quickEntrySubmitEvent, {
        prompt: 'look at this',
        chatId: null,
        modelId: null,
        attachments: [attachment],
      })
    })

    it('attaches an image pasted while focus is outside the textarea', async () => {
      const { result } = render()
      const file = new File(['png-bytes'], '', { type: 'image/png' })
      const paste = new Event('paste', { cancelable: true }) as ClipboardEvent
      Object.defineProperty(paste, 'clipboardData', {
        value: { items: [{ kind: 'file', getAsFile: () => file }] },
      })

      await act(async () => {
        window.dispatchEvent(paste)
        await getClock().runAllAsync()
      })

      expect(paste.defaultPrevented).toBe(true)
      expect(result.current.attachments).toHaveLength(1)
    })

    it('leaves a paste the textarea already took alone, so it attaches once', async () => {
      const { result } = render()
      const paste = pasteImage()
      act(() => result.current.handlePaste(paste))
      const native = new Event('paste', { cancelable: true }) as ClipboardEvent
      Object.defineProperty(native, 'clipboardData', { value: paste.clipboardData })
      native.preventDefault()

      await act(async () => {
        window.dispatchEvent(native)
        await getClock().runAllAsync()
      })

      expect(result.current.attachments).toHaveLength(1)
    })

    it('has nothing to send with no text and no files', () => {
      const { result } = render()

      expect(result.current.canSubmit).toBe(false)
    })
  })
})
