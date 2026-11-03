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
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { toReplyChat, toVoiceOverlayError, useVoiceSession } from './use-voice-session'
import { VoiceModeComposer } from './voice-mode-composer'

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

  /** The overlay line a held voice turn ends on, rendered the way the session shows it. */
  const renderHeldTurnOverlay = async () => {
    const chatInstance = setupPrivateThread(hostedAgent)
    const error = await toReplyChat(chatInstance, 'thread-1')
      .sendMessage({ text: 'Go on' })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      )
    render(<VoiceModeComposer state="listening" error={toVoiceOverlayError(error)} onClose={() => {}} />)
    return chatInstance
  }

  it('refuses a voice turn while the private auto-run hold applies, in the notice copy', async () => {
    const chatInstance = await renderHeldTurnOverlay()

    expect(chatInstance.sendMessage).not.toHaveBeenCalled()
    expect(
      screen.getByText("This private chat won't run on Assistant. Switch to Thunderbolt to run it."),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Error:/)).toBeNull()
  })

  it('drops the switch advice where the deployment has no built-in agent', async () => {
    useConfigStore.setState({ config: { builtInAgentEnabled: false } })
    await renderHeldTurnOverlay()

    expect(screen.getByText("This private chat won't run on Assistant.")).toBeInTheDocument()
  })

  it('sends a voice turn once the chat is on the built-in agent', async () => {
    const chatInstance = setupPrivateThread(builtInAgent)

    await toReplyChat(chatInstance, 'thread-1').sendMessage({ text: 'Go on' })

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
    const { result } = renderHook(useVoiceSession, { wrapper: createQueryTestWrapper() })
    return { result, createSession, start }
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
