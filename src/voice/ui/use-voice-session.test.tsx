/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { builtInAgent } from '@/defaults/agents'
import { createMockChatInstance, createMockChatThread, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { toReplyChat, toVoiceOverlayError } from './use-voice-session'
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
