/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { i18n } from '@/i18n'
import {
  quickEntryOptionsEvent,
  type QuickEntryOptionsPayload,
  quickEntryRequestOptionsEvent,
  quickEntrySubmitEvent,
  quickEntryWindowLabel,
} from './events'
import { useQuickEntryListener } from './use-quick-entry-listener'

type Handler = (event: { payload: unknown }) => void

const db = {} as AnyDrizzleDatabase
const image = { localFileId: 'file-1', filename: 'screenshot.png', mimeType: 'image/png' }
const optionsPayload: QuickEntryOptionsPayload = { models: [], selectedModelId: 'model-a', chats: [] }

const createMainWindow = () => {
  const handlers = new Map<string, Handler>()
  const unlisten = mock(() => {})
  const order: string[] = []
  const mainWindow = {
    show: mock(() => Promise.resolve()),
    setSkipTaskbar: mock(() => Promise.resolve()),
    setFocus: mock(() => Promise.resolve()),
    emitTo: mock((_target: string, _event: string, _payload: unknown) => Promise.resolve()),
    listen: mock((event: string, handler: Handler) => {
      handlers.set(event, handler)
      return Promise.resolve(unlisten)
    }),
  }
  const fire = (event: string, payload?: unknown) => handlers.get(event)?.({ payload })
  return { mainWindow, fire, unlisten, order }
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={db}>
    <MemoryRouter initialEntries={['/chats/existing']}>{children}</MemoryRouter>
  </DatabaseProvider>
)

const render = (enabled: boolean) => {
  const fake = createMainWindow()
  const loadOptions = mock(() => Promise.resolve(optionsPayload))
  const applyModel = mock(async () => {
    fake.order.push('applyModel')
  })
  fake.mainWindow.show.mockImplementation(async () => {
    fake.order.push('show')
  })
  const hook = renderHook(
    () => {
      useQuickEntryListener({
        mainWindow: fake.mainWindow as unknown as NonNullable<
          Parameters<typeof useQuickEntryListener>[0]
        >['mainWindow'],
        enabled,
        loadOptions,
        applyModel,
      })
      return useLocation()
    },
    { wrapper },
  )
  return { ...fake, ...hook, loadOptions, applyModel }
}

describe('useQuickEntryListener', () => {
  it('opens a new chat carrying the prompt, after applying the picked model', async () => {
    const { result, fire, mainWindow, applyModel, order } = render(true)

    await act(async () =>
      fire(quickEntrySubmitEvent, { prompt: 'Plan my week', chatId: null, modelId: 'model-b', attachments: [image] }),
    )

    expect(applyModel).toHaveBeenCalledWith(db, 'model-b')
    expect(order).toEqual(['applyModel', 'show'])
    expect(mainWindow.setFocus).toHaveBeenCalledTimes(1)
    expect(result.current.pathname).toBe('/chats/new')
    expect(result.current.state).toEqual({
      quickEntryPrompt: 'Plan my week',
      quickEntryAttachments: [image],
      newChatRequestId: expect.any(String),
    })
  })

  it('starts a distinct new chat for each prompt', async () => {
    const { result, fire } = render(true)

    await act(async () =>
      fire(quickEntrySubmitEvent, { prompt: 'first', chatId: null, modelId: null, attachments: [] }),
    )
    const firstRequest = result.current.state.newChatRequestId
    await act(async () =>
      fire(quickEntrySubmitEvent, { prompt: 'second', chatId: null, modelId: null, attachments: [] }),
    )

    expect(result.current.state.newChatRequestId).not.toBe(firstRequest)
  })

  it('sends to a picked chat on its own route, leaving the model setting alone', async () => {
    const { result, fire, applyModel } = render(true)

    await act(async () =>
      fire(quickEntrySubmitEvent, { prompt: 'One more thing', chatId: 'chat-7', modelId: null, attachments: [image] }),
    )

    expect(applyModel).not.toHaveBeenCalled()
    expect(result.current.pathname).toBe('/chats/chat-7')
    expect(result.current.state).toEqual({ quickEntryPrompt: 'One more thing', quickEntryAttachments: [image] })
  })

  it('answers a request for options with the list for the Quick Entry window', async () => {
    const { fire, mainWindow, loadOptions } = render(true)

    await act(async () => fire(quickEntryRequestOptionsEvent))

    expect(loadOptions).toHaveBeenCalledWith(db, i18n)
    expect(mainWindow.emitTo).toHaveBeenCalledWith(quickEntryWindowLabel, quickEntryOptionsEvent, optionsPayload)
  })

  it('does not listen off macOS', () => {
    const { mainWindow } = render(false)

    expect(mainWindow.listen).not.toHaveBeenCalled()
  })

  it('stops listening on unmount', async () => {
    const { unmount, unlisten } = render(true)

    unmount()
    await act(() => Promise.resolve())

    expect(unlisten).toHaveBeenCalledTimes(2)
  })
})
