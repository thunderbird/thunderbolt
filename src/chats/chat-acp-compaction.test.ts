/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { DefaultChatTransport, type ChatInit } from 'ai'
import { Chat } from '@ai-sdk/react'
import { builtInAgent } from '@/defaults/agents'
import { useAcpSessionStore } from '@/acp/session-state-store'
import { sessionConfigKey } from '@/acp/session-config-store'
import type { AcpCompaction } from '@/acp/compaction'
import { createTranslatorStream } from '@/acp/translators/acp-to-ai-sdk'
import { createClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockModel,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
import { createChatInstance } from './chat-instance'
import { useChatStore } from './chat-store'

const agent: Agent = {
  ...builtInAgent,
  id: 'external',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://agent.invalid',
}
const reply: ThunderboltUIMessage = { id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Done' }] }
const compaction: AcpCompaction = { agentId: agent.id, sessionId: 'acp-1', compactionId: 'c1', status: 'completed' }

/** Exercise chat persistence and retry callbacks without replacing their implementation. */
const fixture = (save: SaveMessagesFunction = async () => {}) => {
  const saved = mock(save)
  const raw = createMockChatInstance([reply])
  const send = mock(raw.sendMessage)
  const regenerate = mock(raw.regenerate)
  Object.assign(raw, { sendMessage: send, regenerate })
  const callbacks: { current?: ChatInit<ThunderboltUIMessage> } = {}
  const instance = createChatInstance(
    'chat',
    [reply],
    saved,
    createClient({ prefixUrl: 'https://backend.invalid' }),
    () => Object.assign(async () => new Response(), { preconnect: async () => false }),
    {
      createChat: (init) => {
        callbacks.current = init
        return raw
      },
      trackEvent: () => {},
    },
  )
  hydrateStore({
    id: 'chat',
    chatInstance: instance,
    chatThread: createMockChatThread({ agentId: agent.id }),
    selectedModel: createMockModel(),
    triggerData: null,
  })
  useChatStore.getState().updateSession('chat', { selectedAgent: agent })
  const finish = (message: ThunderboltUIMessage = reply, isError = false) =>
    callbacks.current!.onFinish!({
      message,
      messages: instance.messages,
      isAbort: false,
      isDisconnect: false,
      isError,
    })
  return { instance, saved, send, regenerate, finish, callbacks }
}

afterEach(() => {
  resetStore()
  useAcpSessionStore.setState({ sessions: new Map(), owners: new Map() })
})

describe('ACP compaction chat lifecycle', () => {
  it('finishes a silent translator response without the real SDK submitting the command again', async () => {
    const f = fixture()
    const fetch = mock(async () => {
      const { body, translator, close } = createTranslatorStream()
      translator.start()
      if (fetch.mock.calls.length > 1) {
        translator.error('Unexpected command resubmission')
      }
      translator.finish()
      close()
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const sdk = new Chat<ThunderboltUIMessage>({
      transport: new DefaultChatTransport({ fetch }),
      sendAutomaticallyWhen: f.callbacks.current!.sendAutomaticallyWhen,
    })
    await sdk.sendMessage({ text: '/compact', metadata: { acpCommand: 'compact' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sdk.status).toBe('ready')
    expect(sdk.messages).toHaveLength(1)
    expect(sdk.messages[0].role).toBe('user')
    expect(sdk.error).toBeUndefined()
  })

  it('does not automatically resubmit a silent native command through the SDK send predicate', async () => {
    const f = fixture()
    const prompt: ThunderboltUIMessage = {
      id: 'compact',
      role: 'user',
      parts: [{ type: 'text', text: '/compact' }],
      metadata: { acpCommand: 'compact' },
    }
    expect(await f.callbacks.current!.sendAutomaticallyWhen!({ messages: [prompt] })).toBe(false)
    expect(await f.callbacks.current!.sendAutomaticallyWhen!({ messages: [{ ...prompt, metadata: {} }] })).toBe(true)
  })

  it('does not stamp an old agent or session usage onto the current conversation', async () => {
    const f = fixture()
    useAcpSessionStore.getState().set(sessionConfigKey(agent.id, 'chat'), { sessionId: 'current', commands: [] }, {})
    for (const usage of [
      { agentId: 'other-agent', sessionId: 'current', used: 20, size: 100 },
      { agentId: agent.id, sessionId: 'previous', used: 20, size: 100 },
    ]) {
      expect(f.instance.onAcpSessionEvent({ type: 'usage', usage }, false)).toBe(true)
    }
    await getClock().tickAsync(0)
    expect(f.saved).not.toHaveBeenCalled()
    expect(f.instance.messages).toEqual([reply])
  })

  it('reconciles late updates with data parts still waiting for the SDK to consume the stream', async () => {
    const f = fixture()
    Object.assign(f.instance, { status: 'submitted' })
    f.instance.onAcpSessionEvent({ type: 'compaction', compaction }, false)
    expect(f.instance.getAcpCompactions()).toEqual([])
    const streamed: ThunderboltUIMessage = {
      ...reply,
      parts: [{ type: 'data-acp-compaction', data: { ...compaction, status: 'in_progress' } }],
    }
    f.instance.messages = [streamed]
    Object.assign(f.instance, { status: 'ready' })
    await f.finish(streamed)
    expect(f.instance.messages).toHaveLength(1)
    expect(f.instance.getAcpCompactions()).toEqual([compaction])
  })

  it('places session-load replay before the new response even while its request is submitted', async () => {
    const f = fixture()
    Object.assign(f.instance, { status: 'submitted' })
    f.instance.onAcpSessionEvent({ type: 'compaction', compaction }, false, true)
    expect(f.instance.getAcpCompactions()).toEqual([compaction])
    expect(f.instance.messages.at(-1)?.parts[0]).toMatchObject({ type: 'data-acp-compaction' })
    await getClock().tickAsync(0)
    expect(f.saved).toHaveBeenCalledTimes(1)
  })

  it.each([
    [undefined, 'ignored', '/compact'],
    ['', '  Keep decisions  ', '/compact Keep decisions'],
    ['Optional focus', '   ', '/compact'],
  ])(
    'sends the advertised native command with supported arguments (hint: %p)',
    async (inputHint, instructions, expected) => {
      const f = fixture()
      f.instance.messages = []
      useAcpSessionStore.getState().set(
        sessionConfigKey(agent.id, 'chat'),
        {
          sessionId: 'acp-1',
          commands: [{ name: 'compact', description: 'Compact context', inputHint }],
        },
        {},
      )
      await f.instance.compactContext(instructions)
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.send.mock.calls[0][0]).toMatchObject({ text: expected, metadata: { acpCommand: 'compact' } })
      expect(f.saved).not.toHaveBeenCalled()
    },
  )

  it('rejects an unadvertised command and never borrows another session capability', async () => {
    const f = fixture()
    useAcpSessionStore.getState().set(
      sessionConfigKey(agent.id, 'other-thread'),
      {
        sessionId: 'acp-other',
        commands: [{ name: 'compact', description: 'Compact context' }],
      },
      {},
    )
    await expect(f.instance.compactContext()).rejects.toThrow('does not support')
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each([false, true])('reports a native command failure (SDK error state: %s)', async (sdkError) => {
    const f = fixture()
    const error = new Error('Command failed')
    useAcpSessionStore.getState().set(
      sessionConfigKey(agent.id, 'chat'),
      {
        sessionId: 'acp-1',
        commands: [{ name: 'compact', description: 'Compact context' }],
      },
      {},
    )
    f.send.mockImplementation(async () => {
      if (sdkError) {
        Object.assign(f.instance, { error })
        return
      }
      throw error
    })
    await expect(f.instance.compactContext()).rejects.toThrow('Command failed')
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.regenerate).not.toHaveBeenCalled()
  })

  it.each([false, true])('does not auto-retry a silent native command (error: %s)', async (isError) => {
    const f = fixture()
    f.instance.messages = [
      { id: 'command', role: 'user', parts: [{ type: 'text', text: '/compact' }], metadata: { acpCommand: 'compact' } },
    ]
    if (isError) {
      f.callbacks.current!.onError!(new Error('Compaction failed'))
    }
    await f.finish({ id: 'empty', role: 'assistant', parts: [] }, isError)
    await getClock().tickAsync(120_000)
    expect(f.regenerate).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions.get('chat')?.retryCount).toBe(0)
    expect(useChatStore.getState().sessions.get('chat')?.retriesExhausted).toBe(isError)
  })

  it('persists idle usage without changing billable usage', async () => {
    const saved = Promise.withResolvers<void>()
    const f = fixture(async () => saved.resolve())
    const usage = { agentId: agent.id, sessionId: 'acp-1', used: 30, size: 1000 }
    expect(f.instance.onAcpSessionEvent({ type: 'usage', usage }, false)).toBe(true)
    await saved.promise
    expect(f.saved.mock.calls[0][0].messages[0].metadata).toEqual({ acpContextUsage: usage, contextTokens: 30 })
    expect(f.instance.messages.at(-1)?.metadata?.usage).toBeUndefined()
  })

  it('queues late events until the final stream save finishes', async () => {
    const firstSave = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture(async () => {
      if (f.saved.mock.calls.length === 1) {
        entered.resolve()
        await firstSave.promise
      }
    })
    Object.assign(f.instance, { status: 'streaming' })
    const finishing = f.finish()
    await entered.promise
    Object.assign(f.instance, { status: 'ready' })
    expect(f.instance.onAcpSessionEvent({ type: 'compaction', compaction }, false)).toBe(true)
    expect(f.instance.getAcpCompactions()).toEqual([])
    expect(f.saved).toHaveBeenCalledTimes(1)
    firstSave.resolve()
    await finishing
    expect(f.saved).toHaveBeenCalledTimes(2)
    expect(f.instance.getAcpCompactions()).toEqual([compaction])
    expect(f.saved.mock.calls[1][0].messages[0].parts[0].type).toBe('data-acp-compaction')
  })

  it('queues a historical entity patch during final persistence even while another prompt owns the stream', async () => {
    const firstSave = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture(async () => {
      if (f.saved.mock.calls.length === 1) {
        entered.resolve()
        await firstSave.promise
      }
    })
    f.instance.messages = [
      {
        id: 'historical-compaction',
        role: 'assistant',
        parts: [
          {
            type: 'data-acp-compaction',
            data: { ...compaction, status: 'in_progress' },
          },
        ],
      },
      reply,
    ]
    const finishing = f.finish()
    await entered.promise
    expect(f.instance.onAcpSessionEvent({ type: 'compaction', compaction }, true)).toBe(true)
    expect(f.instance.getAcpCompactions()[0].status).toBe('in_progress')
    firstSave.resolve()
    await finishing
    expect(f.instance.getAcpCompactions()).toEqual([compaction])
    expect(f.saved).toHaveBeenCalledTimes(2)
    expect(f.saved.mock.calls[1][0].messages[0].id).toBe('historical-compaction')
  })

  it('waits for final persistence and queued session events before starting the next user turn', async () => {
    const finalSave = Promise.withResolvers<void>()
    const finalEntered = Promise.withResolvers<void>()
    const eventSave = Promise.withResolvers<void>()
    const eventEntered = Promise.withResolvers<void>()
    const f = fixture(async () => {
      if (f.saved.mock.calls.length === 1) {
        finalEntered.resolve()
        await finalSave.promise
        return
      }
      eventEntered.resolve()
      await eventSave.promise
    })
    const finishing = f.finish()
    await finalEntered.promise
    Object.assign(f.instance, { status: 'ready' })
    f.instance.onAcpSessionEvent({ type: 'compaction', compaction }, false)
    const sending = f.instance.sendMessage({ text: 'Next question' })
    await getClock().tickAsync(0)
    expect(f.send).not.toHaveBeenCalled()

    finalSave.resolve()
    await eventEntered.promise
    expect(f.send).not.toHaveBeenCalled()
    expect(f.instance.getAcpCompactions()).toEqual([compaction])
    eventSave.resolve()
    await Promise.all([finishing, sending])
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0][0]).toMatchObject({ text: 'Next question' })
  })

  it('updates idle/replayed entities under a stable message id', async () => {
    const saved = Promise.withResolvers<void>()
    const firstSave = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture(async () => {
      if (f.saved.mock.calls.length === 1) {
        entered.resolve()
        await firstSave.promise
      }
      if (f.saved.mock.calls.length === 2) {
        saved.resolve()
      }
    })
    f.instance.onAcpSessionEvent({ type: 'compaction', compaction: { ...compaction, status: 'in_progress' } }, false)
    f.instance.onAcpSessionEvent({ type: 'compaction', compaction }, false)
    await entered.promise
    expect(f.saved).toHaveBeenCalledTimes(1)
    firstSave.resolve()
    await saved.promise
    expect(f.instance.getAcpCompactions()).toEqual([compaction])
    expect(f.saved.mock.calls[0][0].messages[0].id).toBe(f.saved.mock.calls[1][0].messages[0].id)
  })
})
