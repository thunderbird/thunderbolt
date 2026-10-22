/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { builtInAgent } from '@/defaults/agents'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockModel,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createChatReply } from '@/voice/chat-reply'
import { createVoiceEngine } from '@/voice/engine/router'
import { isVoiceModeActive } from '@/voice/voice-mode'
import { toReplyChat, toVoiceOverlayError, useVoiceSession } from './use-voice-session'
import { VoiceModeComposer } from './voice-mode-composer'

const hostedAgent: Agent = {
  ...builtInAgent,
  id: 'hosted-agent',
  name: 'Assistant',
  type: 'managed-http',
  isPrivate: false,
  voice: undefined,
}

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
  })

  /** The overlay line a held voice turn ends on, rendered the way the session shows it. */
  const renderHeldTurnOverlay = async () => {
    const chatInstance = setupPrivateThread(hostedAgent)
    const error = await toReplyChat(chatInstance, 'thread-1', hostedAgent.id)
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
    expect(screen.getByText("This private chat won't run on Assistant.")).toBeInTheDocument()
    expect(screen.queryByText(/^Error:/)).toBeNull()
  })

  it('sends a voice turn through the agent the voice session started with', async () => {
    const chatInstance = setupPrivateThread(builtInAgent)

    await toReplyChat(chatInstance, 'thread-1', builtInAgent.id).sendMessage({ text: 'Go on' })

    expect(chatInstance.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('refuses to send a transcript through a different agent', async () => {
    const chatInstance = setupPrivateThread(hostedAgent)

    await expect(toReplyChat(chatInstance, 'thread-1', builtInAgent.id).sendMessage({ text: 'Go on' })).rejects.toThrow(
      'The agent for this voice session changed',
    )
    expect(chatInstance.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses to send after its chat session was removed', async () => {
    const chatInstance = setupPrivateThread(builtInAgent)
    resetStore()

    await expect(toReplyChat(chatInstance, 'thread-1', builtInAgent.id).sendMessage({ text: 'Go on' })).rejects.toThrow(
      'The agent for this voice session changed',
    )
    expect(chatInstance.sendMessage).not.toHaveBeenCalled()
  })
})

/** Hold the code-split import boundary without loading microphone or playback APIs. */
const deferredVoiceRuntime = () => {
  const session = {
    start: mock(async () => {}),
    stop: mock(async () => {}),
    state: 'idle' as const,
    getOutputLevel: () => 0,
  }
  const runtime = {
    createVoiceSession: mock(() => session),
    createVoiceEngine: mock(createVoiceEngine),
    createChatReply,
  }
  let resolve!: (value: typeof runtime) => void
  const pending = new Promise<typeof runtime>((fulfill) => {
    resolve = fulfill
  })
  return { runtime, session, load: mock(() => pending), resolve: () => resolve(runtime) }
}

describe('useVoiceSession startup', () => {
  afterEach(() => {
    cleanup()
    resetStore()
  })

  it('validates the live model before loading voice or locking the agent', async () => {
    setupPrivateThread(builtInAgent)
    const deferred = deferredVoiceRuntime()
    const { result } = renderHook(() => useVoiceSession(deferred.load))
    act(() => {
      useChatStore.getState().updateSession('thread-1', { selectedModel: createMockModel({ enabled: 0 }) })
    })
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await act(() => result.current.start())

      expect(deferred.load).not.toHaveBeenCalled()
      expect(useChatStore.getState().sessions.get('thread-1')?.agentLocked).not.toBe(true)
      expect(result.current.error).toContain('This model is not available for the selected agent')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not open a microphone after stop cancels a pending runtime import', async () => {
    setupPrivateThread(builtInAgent)
    const deferred = deferredVoiceRuntime()
    const { result } = renderHook(() => useVoiceSession(deferred.load))
    let startup!: Promise<void>
    act(() => {
      startup = result.current.start()
    })
    expect(useChatStore.getState().sessions.get('thread-1')?.agentLocked).toBe(true)

    await act(() => result.current.stop())
    await act(async () => {
      deferred.resolve()
      await startup
    })

    expect(deferred.runtime.createVoiceSession).not.toHaveBeenCalled()
    expect(result.current.active).toBe(false)
    expect(isVoiceModeActive()).toBe(false)
  })

  it('does not open a microphone after the composer unmounts during import', async () => {
    setupPrivateThread(builtInAgent)
    const deferred = deferredVoiceRuntime()
    const { result, unmount } = renderHook(() => useVoiceSession(deferred.load))
    let startup!: Promise<void>
    act(() => {
      startup = result.current.start()
    })
    unmount()
    deferred.resolve()
    await startup

    expect(deferred.runtime.createVoiceSession).not.toHaveBeenCalled()
    expect(isVoiceModeActive()).toBe(false)
  })

  it('rechecks the live model before opening audio after a pending import', async () => {
    setupPrivateThread(builtInAgent)
    const deferred = deferredVoiceRuntime()
    const { result } = renderHook(() => useVoiceSession(deferred.load))
    let startup!: Promise<void>
    act(() => {
      startup = result.current.start()
      useChatStore.getState().updateSession('thread-1', { selectedModel: createMockModel({ enabled: 0 }) })
    })
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await act(async () => {
        deferred.resolve()
        await startup
      })

      expect(deferred.runtime.createVoiceEngine).not.toHaveBeenCalled()
      expect(deferred.runtime.createVoiceSession).not.toHaveBeenCalled()
      expect(result.current.error).toContain('This model is not available for the selected agent')
      expect(isVoiceModeActive()).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })
})
