/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { builtInAgent } from '@/defaults/agents'
import { updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { showSignInModalEvent } from '@/hooks/use-credential-events'
import { setCachedSession } from '@/lib/session-cache'
import { defaultVoiceProvider, useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockChatInstance, createMockChatThread, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
import * as voiceSession from '@/voice/session'
import { isVoiceModeActive } from '@/voice/voice-mode'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { voiceUiReducer, toReplyChat, useVoiceSession } from './use-voice-session'

const hostedAgent: Agent = { ...builtInAgent, id: 'hosted-agent', name: 'Assistant', type: 'managed-http' }

/** A private automation thread ending on its unanswered prompt, resolved to `agent`. */
const setupPrivateThread = (agent: Agent) => {
  const messages: ThunderboltUIMessage[] = [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }]
  const chatInstance = createMockChatInstance(messages, 'ready')
  hydrateStore({
    chatInstance,
    chatThread: createMockChatThread({ isEncrypted: 1 }),
    id: 'thread-1',
    selectedModel: null,
    triggerData: null,
  })
  useChatStore.getState().updateSession('thread-1', { selectedAgent: agent })
  return chatInstance
}

describe('toReplyChat', () => {
  afterEach(() => {
    resetStore()
    useConfigStore.setState({ config: {} })
  })

  it('sends voice turns on a legacy private chat through the selected agent', async () => {
    const chatInstance = setupPrivateThread(hostedAgent)
    await toReplyChat(chatInstance).sendMessage({ text: 'Go on' })
    expect(chatInstance.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('sends a voice turn once the chat is on the built-in agent', async () => {
    const chatInstance = setupPrivateThread(builtInAgent)

    await toReplyChat(chatInstance).sendMessage({ text: 'Go on' })

    expect(chatInstance.sendMessage).toHaveBeenCalledTimes(1)
  })
})

describe('hosted voice sign-in gate', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(async () => {
    cleanup()
    mock.restore()
    resetStore()
    useLocalSettingsStore.setState({ voiceProvider: defaultVoiceProvider })
    await resetTestDatabase()
  })

  /** Captures startup without opening a microphone or making an attestation request. */
  const renderVoice = () => {
    setupPrivateThread(builtInAgent)
    const start = mock(async () => {})
    const createSession = spyOn(voiceSession, 'createVoiceSession').mockReturnValue({
      start,
      stop: async () => {},
      state: 'idle',
      getOutputLevel: () => 0,
    })
    const { result, unmount } = renderHook(useVoiceSession, { wrapper: createQueryTestWrapper() })
    return { result, unmount, createSession, start }
  }

  it.each(['', 'https://server.example/v1'])(
    'prompts for server/sign-in before starting hosted voice: %s',
    async (cloudUrl) => {
      useLocalSettingsStore.setState({ cloudUrl, localMode: true, voiceProvider: defaultVoiceProvider })
      const { result, createSession } = renderVoice()
      const onSignIn = mock()
      window.addEventListener(showSignInModalEvent, onSignIn)
      try {
        await act(() => result.current.start())
        expect(onSignIn).toHaveBeenCalledTimes(1)
        expect(createSession).not.toHaveBeenCalled()
        expect(result.current.active).toBe(false)
        expect(isVoiceModeActive()).toBe(false)
      } finally {
        window.removeEventListener(showSignInModalEvent, onSignIn)
      }
    },
  )

  it('does not open the microphone after stop during lazy startup', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: true })
    setCachedSession({ user: { id: 'sso-user' }, session: { expiresAt: new Date(Date.now() + 60_000) } })
    const { result, createSession } = renderVoice()
    await act(async () => {
      const pending = result.current.start()
      await result.current.stop()
      await pending
    })
    expect(createSession).not.toHaveBeenCalled()
    expect(result.current.active).toBe(false)
    expect(isVoiceModeActive()).toBe(false)
  })

  it('does not create an orphan voice session after unmount during startup', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: true })
    setCachedSession({ user: { id: 'sso-user' }, session: { expiresAt: new Date(Date.now() + 60_000) } })
    const { result, unmount, createSession } = renderVoice()
    await act(async () => {
      const pending = result.current.start()
      unmount()
      await pending
    })
    expect(createSession).not.toHaveBeenCalled()
    expect(isVoiceModeActive()).toBe(false)
  })

  it('can restart immediately after cancelling startup without the old stop hiding it', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: true })
    setCachedSession({ user: { id: 'sso-user' }, session: { expiresAt: new Date(Date.now() + 60_000) } })
    const { result, createSession, start } = renderVoice()
    await act(async () => {
      const cancelled = result.current.start()
      const stopped = result.current.stop()
      const restarted = result.current.start()
      await Promise.all([cancelled, stopped, restarted])
    })
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(result.current.active).toBe(true)
    expect(isVoiceModeActive()).toBe(true)
  })

  it('coalesces repeated starts while loading the voice runtime', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: true })
    setCachedSession({ user: { id: 'sso-user' }, session: { expiresAt: new Date(Date.now() + 60_000) } })
    const { result, createSession, start } = renderVoice()
    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()])
    })
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('starts hosted voice for a cookie-authenticated server session', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://server.example/v1', localMode: true })
    setCachedSession({ user: { id: 'sso-user' }, session: { expiresAt: new Date(Date.now() + 60_000) } })
    const { result, createSession, start } = renderVoice()
    await act(() => result.current.start())
    expect(createSession.mock.calls[0]?.[0].engine.id).toBe('thunderbolt')
    expect(start).toHaveBeenCalledTimes(1)
    expect(result.current.active).toBe(true)
  })

  it('keeps configured OpenAI-compatible voice usable without a Thunderbolt server', async () => {
    useLocalSettingsStore.setState({
      cloudUrl: '',
      localMode: true,
      voiceProvider: { ...defaultVoiceProvider, kind: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' },
    })
    await updateSettings(getDb(), { experimental_feature_voice: true })
    const { result, createSession, start } = renderVoice()
    await act(() => result.current.start())
    expect(createSession.mock.calls[0]?.[0].engine.id).toBe('openai-compatible')
    expect(start).toHaveBeenCalledTimes(1)
    expect(result.current.active).toBe(true)
  })
})

it('models a startup failure even after the session emitted a loading state', () => {
  const starting = voiceUiReducer({ phase: 'closed' }, { type: 'START' })
  const loading = voiceUiReducer(starting, { type: 'STATE', state: 'listening' })
  expect(voiceUiReducer(loading, { type: 'START_FAILED', error: 'microphone unavailable' })).toEqual({
    phase: 'failed',
    error: 'microphone unavailable',
  })
})

describe('voice UI transitions', () => {
  it('ignores callbacks after closure or terminal failure and starts a clean retry', () => {
    const closed = { phase: 'closed' } as const
    expect(voiceUiReducer(closed, { type: 'STATE', state: 'listening' })).toBe(closed)
    expect(voiceUiReducer(closed, { type: 'ERROR', error: 'late' })).toBe(closed)
    const failed = voiceUiReducer({ phase: 'starting' }, { type: 'ERROR', error: 'unavailable' })
    expect(failed).toEqual({ phase: 'failed', error: 'unavailable' })
    expect(voiceUiReducer(failed, { type: 'STATE', state: 'listening' })).toBe(failed)
    expect(voiceUiReducer(failed, { type: 'START' })).toEqual({ phase: 'starting' })
    expect(voiceUiReducer(failed, { type: 'STOP' })).toEqual(closed)
  })

  it('keeps a recoverable error visible while the running session changes state', () => {
    const listening = voiceUiReducer({ phase: 'starting' }, { type: 'STATE', state: 'listening' })
    expect(listening).toEqual({ phase: 'running', state: 'listening', error: null })
    const failedTurn = voiceUiReducer(listening, { type: 'ERROR', error: 'network error' })
    expect(failedTurn).toEqual({ phase: 'running', state: 'listening', error: 'network error' })
    expect(voiceUiReducer(failedTurn, { type: 'STATE', state: 'thinking' })).toEqual({
      phase: 'running',
      state: 'thinking',
      error: 'network error',
    })
    expect(voiceUiReducer(failedTurn, { type: 'STOP' })).toEqual({ phase: 'closed' })
  })
})
