/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aiReact from '@ai-sdk/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { useChatStore } from '@/chats/chat-store'
import { CreateItemProvider } from '@/components/create-item/context'
import { ContentViewProvider } from '@/content-view/context'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import * as attachments from '@/lib/file-blob-storage'
import { clearAuthToken, setAuthToken } from '@/lib/auth-token'
import { clearCachedSession } from '@/lib/session-cache'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import {
  createMockChatInstance,
  createMockModel,
  createMockUseChat,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import ChatUI from './chat-ui'

/** Keep the real composer and setup screen; only replace network and file persistence boundaries. */
const renderChat = (access: 'cloud session' | 'provider connection') => {
  const cloudUrl = 'https://cloud.example/v1'
  const isCloud = access === 'cloud session'
  if (isCloud) {
    useLocalSettingsStore.setState({ cloudUrl })
    setAuthToken('active-session', cloudUrl)
  }
  const model = createMockModel(
    isCloud
      ? { provider: 'thunderbolt', isSystem: 1, apiKey: null }
      : { provider: 'tinfoil', oauthProvider: 'tinfoil', apiKey: null },
  )
  const chat = createMockChatInstance()
  spyOn(aiReact, 'useChat').mockImplementation(createMockUseChat(chat))
  spyOn(attachments, 'putAttachment').mockResolvedValue(undefined)
  hydrateStore({
    chatInstance: chat,
    chatThread: null,
    id: 'new',
    models: [model],
    selectedModel: model,
    triggerData: null,
  })
  const QueryWrapper = createQueryTestWrapper()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <CreateItemProvider>
        <ContentViewProvider>
          <QueryWrapper>{children}</QueryWrapper>
        </ContentViewProvider>
      </CreateItemProvider>
    </MemoryRouter>
  )
  return {
    ...render(<ChatUI />, { wrapper }),
    chat,
    expireAccess: () => (isCloud ? clearAuthToken() : useChatStore.getState().setModels([])),
    restoreAccess: () =>
      isCloud ? setAuthToken('renewed-session', cloudUrl) : useChatStore.getState().setModels([model]),
  }
}

describe('ChatUI model setup', () => {
  let restoreSettings: () => void
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(() => {
    const previousSettings = useLocalSettingsStore.getState()
    const savedAuth = ['thunderbolt_auth_token', 'thunderbolt_session_cache'].map(
      (key) => [key, localStorage.getItem(key)] as const,
    )
    restoreSettings = () => {
      useLocalSettingsStore.setState(previousSettings)
      for (const [key, value] of savedAuth) {
        if (value === null) {
          localStorage.removeItem(key)
        } else {
          localStorage.setItem(key, value)
        }
      }
    }
    clearAuthToken()
    clearCachedSession()
    resetStore()
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true, serverHasAuthenticated: false })
  })
  afterEach(async () => {
    cleanup()
    mock.restore()
    restoreSettings()
    resetStore()
    await resetTestDatabase()
  })

  it.each(['cloud session', 'provider connection'] as const)(
    'keeps a new-chat draft and attachments when its %s expires and reconnects, while blocking sends',
    async (access) => {
      const { container, chat, expireAccess, restoreAccess } = renderChat(access)
      const textarea = screen.getByPlaceholderText('Ask me anything…')
      fireEvent.change(textarea, { target: { value: 'Please review these notes.' } })
      fireEvent.drop(textarea, {
        dataTransfer: { types: ['Files'], files: [new File(['draft notes'], 'notes.txt', { type: 'text/plain' })] },
      })
      await act(async () => getClock().runAllAsync())
      expect(screen.getByLabelText('Remove notes.txt')).toBeVisible()
      const form = container.querySelector('form')!

      act(expireAccess)
      expect(screen.getByRole('heading', { name: 'Connect your AI' })).toBeVisible()
      expect(textarea).toBeInTheDocument()
      expect(textarea).not.toBeVisible()
      expect(textarea).toHaveValue('Please review these notes.')
      expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
      await act(async () => fireEvent.submit(form))
      expect(chat.sendMessage).not.toHaveBeenCalled()

      act(restoreAccess)
      expect(screen.queryByRole('heading', { name: 'Connect your AI' })).toBeNull()
      expect(screen.getByPlaceholderText('Ask me anything…')).toBe(textarea)
      expect(textarea).toBeVisible()
      expect(textarea).toHaveValue('Please review these notes.')
      expect(screen.getByLabelText('Remove notes.txt')).toBeVisible()
      await act(async () => fireEvent.submit(form))
      expect(chat.sendMessage).toHaveBeenCalledTimes(1)
      const sent = JSON.stringify((chat.sendMessage as ReturnType<typeof mock>).mock.calls[0])
      expect(sent).toContain('Please review these notes.')
      expect(sent).toContain('notes.txt')
    },
  )
})
