/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import { createClient } from '@/lib/http'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockModel,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { AgentAdapter } from '@/types/acp'
import type { CompactionCheckpoint } from '@shared/agent-core'
import { createChatInstance } from './chat-instance'
import { useChatStore } from './chat-store'
import { stoppedReplyMarker } from '@shared/agent-core/stopped-reply'
import type { ChatInit } from 'ai'
import { getClock } from '@/testing-library'

afterEach(resetStore)

const checkpoint: CompactionCheckpoint = {
  version: 1,
  summary: 'Decisions',
  tokensBefore: 9_000,
  contextTokens: 100,
  retainedTail: [],
}

/** Exercise the real chat control path with a controllable adapter operation. */
const fixture = (
  compact: NonNullable<AgentAdapter['compact']> = async () => checkpoint,
  save: SaveMessagesFunction = async () => {},
) => {
  const messages: ThunderboltUIMessage[] = [
    { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
    { id: 'assistant', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }] },
  ]
  const model = createMockModel()
  const saved = mock(save)
  const adapterCompact = mock(compact)
  const adapter: AgentAdapter = {
    agent: builtInAgent,
    capabilities: null,
    fetch: mock(async () => new Response()),
    compact: adapterCompact,
    ensureSession: async () => {},
    disconnect: () => {},
  }
  const callbacks: { current?: ChatInit<ThunderboltUIMessage> } = {}
  const instance = createChatInstance(
    'chat',
    messages,
    saved,
    createClient({ prefixUrl: 'https://backend.test' }),
    () => Object.assign(async () => new Response(), { preconnect: async () => false }),
    {
      getChatReasoningEffort: async () => undefined,
      getAvailableModels: async () => useChatStore.getState().models,
      getOrConnectAdapter: async () => adapter,
      createChat: (init) => {
        callbacks.current = init
        return createMockChatInstance(messages)
      },
      trackEvent: () => {},
    },
  )
  hydrateStore({
    id: 'chat',
    chatInstance: instance,
    chatThread: createMockChatThread(),
    models: [model],
    selectedModel: model,
    triggerData: null,
  })
  const finish = (message = messages[1], isAbort = false) =>
    callbacks.current!.onFinish!({
      message,
      messages: instance.messages,
      isAbort,
      isDisconnect: false,
      isError: false,
    })
  return { instance, saved, adapterCompact, adapter, messages, finish }
}

describe('chat compaction control', () => {
  it('releases a rejected final save so compaction can be retried', async () => {
    const finalSave = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture(undefined, async () => {
      entered.resolve()
      await finalSave.promise
    })
    const finishing = f.finish()
    await entered.promise
    const compacting = f.instance.compactContext()
    const settled = Promise.allSettled([finishing, compacting])
    const failure = new Error('disk full')
    finalSave.reject(failure)
    expect(await settled).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    expect(f.adapterCompact).not.toHaveBeenCalled()
    f.saved.mockImplementation(async () => {})
    await f.instance.compactContext()
    expect(f.instance.messages.at(-1)?.metadata?.contextCompaction).toEqual(checkpoint)
  })

  it('also waits for a reply save that begins while compaction is waiting on an older save', async () => {
    const firstSave = Promise.withResolvers<void>()
    const secondSave = Promise.withResolvers<void>()
    const firstEntered = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const f = fixture(undefined, async () => {
      if (f.saved.mock.calls.length === 1) {
        firstEntered.resolve()
        await firstSave.promise
      } else if (f.saved.mock.calls.length === 2) {
        secondEntered.resolve()
        await secondSave.promise
      }
    })
    const firstFinish = f.finish()
    await firstEntered.promise
    const compacting = f.instance.compactContext()
    const nextReply = { ...f.messages[1], id: 'next-reply' }
    await f.instance.sendMessage({ text: 'Follow-up' })
    f.instance.messages = [
      ...f.messages,
      { id: 'next-user', role: 'user', parts: [{ type: 'text', text: 'Follow-up' }] },
      nextReply,
    ]
    const secondFinish = f.finish(nextReply)
    await secondEntered.promise
    firstSave.resolve()
    await firstFinish
    await getClock().tickAsync(0)
    const callsBeforeSecondSave = f.adapterCompact.mock.calls.length
    secondSave.resolve()
    await Promise.all([secondFinish, compacting])
    expect(callsBeforeSecondSave).toBe(0)
    expect(f.saved.mock.calls.at(-1)?.[0].messages[0].id).toBe('next-reply')
  })

  it('waits for an older reply save even after a newer stopped turn has finished', async () => {
    const finalSave = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture(undefined, async ({ messages }) => {
      if (messages[0].id === 'assistant' && !messages[0].metadata?.contextCompaction) {
        entered.resolve()
        await finalSave.promise
      }
    })
    const firstFinish = f.finish()
    await entered.promise
    await f.instance.sendMessage({ text: 'Follow-up' })
    f.instance.messages = [
      ...f.messages,
      { id: 'next-user', role: 'user', parts: [{ type: 'text', text: 'Follow-up' }] },
    ]
    await f.finish({ id: 'stopped', role: 'assistant', parts: [] }, true)
    const compacting = f.instance.compactContext()
    await getClock().tickAsync(0)
    const callsBeforeFinalSave = f.adapterCompact.mock.calls.length
    finalSave.resolve()
    await Promise.all([firstFinish, compacting])
    expect(callsBeforeFinalSave).toBe(0)
    expect(f.saved.mock.calls.at(-1)?.[0].messages[0].metadata?.contextCompaction).toEqual(checkpoint)
  })

  it('waits for the completed reply to be saved before replacing its context checkpoint', async () => {
    const finalSave = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const persisted: ThunderboltUIMessage[] = []
    const f = fixture(undefined, async ({ messages }) => {
      if (!messages[0].metadata?.contextCompaction) {
        entered.resolve()
        await finalSave.promise
      }
      persisted.push(messages[0])
    })
    const finishing = f.finish()
    await entered.promise
    const compacting = f.instance.compactContext()
    await getClock().tickAsync(0)
    const callsBeforeFinalSave = f.adapterCompact.mock.calls.length
    finalSave.resolve()
    await Promise.all([finishing, compacting])
    expect(callsBeforeFinalSave).toBe(0)
    expect(persisted.at(-1)?.metadata?.contextCompaction).toEqual(checkpoint)
  })

  it('includes the cancellation marker for the latest reasoning-only reply in a manual summary', async () => {
    const f = fixture()
    const pending: ThunderboltUIMessage[] = [
      {
        id: 'stopped-user',
        role: 'user',
        parts: [{ type: 'text', text: 'Cancelled question' }],
        metadata: { stoppedByUser: true },
      },
      { id: 'reasoning', role: 'assistant', parts: [{ type: 'reasoning', text: 'Planning' }] },
    ]
    f.instance.messages = [...f.messages, ...pending]
    await f.instance.compactContext()
    const summarized = JSON.parse(String(f.adapterCompact.mock.calls[0][0].body)).messages as ThunderboltUIMessage[]
    expect(summarized.at(-1)?.parts).toEqual([{ type: 'text', text: stoppedReplyMarker }])
    expect(f.instance.messages.map(({ id }) => id)).toEqual(['user', 'assistant', 'stopped-user', 'reasoning'])
    expect(f.saved.mock.calls[0][0].messages[0].id).toBe('reasoning')
  })

  it('summarizes stopped-turn markers without inserting them into the visible or saved transcript', async () => {
    const f = fixture()
    const stopped: ThunderboltUIMessage = {
      id: 'stopped-user',
      role: 'user',
      parts: [{ type: 'text', text: 'Cancelled question' }],
      metadata: { stoppedByUser: true },
    }
    f.instance.messages = [stopped, ...f.messages]
    await f.instance.compactContext()
    const summarized = JSON.parse(String(f.adapterCompact.mock.calls[0][0].body)).messages as ThunderboltUIMessage[]
    expect(summarized.map(({ id }) => id)).toEqual(['stopped-user', 'stopped-user-stopped', 'user', 'assistant'])
    expect(summarized[1].parts).toEqual([{ type: 'text', text: stoppedReplyMarker }])
    expect(f.instance.messages.map(({ id }) => id)).toEqual(['stopped-user', 'user', 'assistant'])
    expect(f.saved.mock.calls[0][0].messages.map(({ id }) => id)).toEqual(['assistant'])
    expect(f.instance.messages.at(-1)?.metadata?.contextCompaction).toEqual(checkpoint)
  })

  it('preserves all trailing unanswered messages and refuses a chat with no response yet', async () => {
    const f = fixture()
    const pending: ThunderboltUIMessage[] = [
      { id: 'pending-1', role: 'user', parts: [{ type: 'text', text: 'First unanswered question' }] },
      { id: 'pending-2', role: 'user', parts: [{ type: 'text', text: 'Follow-up' }] },
    ]
    f.instance.messages = [...f.messages, ...pending]
    await f.instance.compactContext()
    expect(JSON.parse(String(f.adapterCompact.mock.calls[0][0].body)).messages).toEqual(f.messages)
    expect(f.instance.messages.slice(-2)).toEqual(pending)
    expect(f.saved.mock.calls[0][0].messages[0].id).toBe('assistant')
    f.instance.messages = pending
    await expect(f.instance.compactContext()).rejects.toThrow('Nothing to compact')
    expect(f.adapterCompact).toHaveBeenCalledTimes(1)
  })

  it('persists and publishes the checkpoint while preserving all visible messages', async () => {
    const f = fixture()
    await f.instance.compactContext('Preserve decisions')
    expect(f.adapterCompact.mock.calls[0][2]).toBe('Preserve decisions')
    expect(f.adapter.fetch).not.toHaveBeenCalled()
    expect(f.saved).toHaveBeenCalledTimes(1)
    expect(f.instance.messages.map(({ parts }) => parts)).toEqual(f.messages.map(({ parts }) => parts))
    expect(f.instance.messages.at(-1)?.metadata?.contextCompaction).toEqual(checkpoint)
    expect(useChatStore.getState().sessions.get('chat')?.compactionStatus).toBe('compacted')
    await f.instance.sendMessage({ text: 'Continue' })
    expect(useChatStore.getState().sessions.get('chat')?.compactionStatus).toBe('idle')
  })

  it('blocks duplicate compaction, sends and regeneration until persistence finishes', async () => {
    const saving = Promise.withResolvers<void>()
    const enteredSave = Promise.withResolvers<void>()
    const f = fixture(undefined, async () => {
      enteredSave.resolve()
      await saving.promise
    })
    const pending = f.instance.compactContext()
    await enteredSave.promise
    expect(useChatStore.getState().sessions.get('chat')?.compactionStatus).toBe('compacting')
    await expect(f.instance.compactContext()).rejects.toThrow('Wait for context compaction')
    await expect(f.instance.sendMessage({ text: 'Another question' })).rejects.toThrow('Wait for context compaction')
    await expect(f.instance.regenerate()).rejects.toThrow('Wait for context compaction')
    saving.resolve()
    await pending
    expect(useChatStore.getState().sessions.get('chat')?.compactionStatus).toBe('compacted')
  })

  it('does not publish an unpersisted checkpoint and allows retry after a save failure', async () => {
    const f = fixture(undefined, async () => {
      throw new Error('disk full')
    })
    await expect(f.instance.compactContext()).rejects.toThrow('disk full')
    expect(f.instance.messages).toBe(f.messages)
    expect(f.instance.messages.at(-1)?.metadata).toBeUndefined()
    expect(useChatStore.getState().sessions.get('chat')?.compactionStatus).toBe('idle')
    f.saved.mockImplementation(async () => {})
    await f.instance.compactContext()
    expect(f.instance.messages.at(-1)?.metadata?.contextCompaction).toEqual(checkpoint)
  })

  it('Stop aborts manual compaction without persisting a result', async () => {
    const entered = Promise.withResolvers<void>()
    const f = fixture(async (init) => {
      entered.resolve()
      await new Promise<void>((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }),
      )
      return checkpoint
    })
    const pending = f.instance.compactContext()
    await entered.promise
    await f.instance.stop()
    await expect(pending).rejects.toThrow('Aborted')
    expect(f.saved).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions.get('chat')?.compactionStatus).toBe('idle')
  })

  it('rejects a stale summary when the transcript changes while the provider is running', async () => {
    const result = Promise.withResolvers<CompactionCheckpoint>()
    const entered = Promise.withResolvers<void>()
    const f = fixture(async () => {
      entered.resolve()
      return result.promise
    })
    const pending = f.instance.compactContext()
    await entered.promise
    const replacement: ThunderboltUIMessage[] = [
      ...f.messages,
      { id: 'synced-user', role: 'user', parts: [{ type: 'text', text: 'Arrived from another device' }] },
    ]
    f.instance.messages = replacement
    result.resolve(checkpoint)
    await expect(pending).rejects.toThrow('conversation changed')
    expect(f.saved).not.toHaveBeenCalled()
    expect(f.instance.messages).toBe(replacement)
    expect(useChatStore.getState().sessions.get('chat')?.compactionStatus).toBe('idle')
    await f.instance.compactContext()
    expect(f.saved).toHaveBeenCalledTimes(1)
  })

  it('discards a late provider result after Stop even if the provider ignores cancellation', async () => {
    const result = Promise.withResolvers<CompactionCheckpoint>()
    const entered = Promise.withResolvers<void>()
    const f = fixture(async () => {
      entered.resolve()
      return result.promise
    })
    const pending = f.instance.compactContext()
    await entered.promise
    await f.instance.stop()
    result.resolve(checkpoint)
    await expect(pending).rejects.toThrow()
    expect(f.saved).not.toHaveBeenCalled()
    expect(f.instance.messages).toBe(f.messages)
    expect(useChatStore.getState().sessions.get('chat')?.compactionStatus).toBe('idle')
  })

  it('rejects compaction while generating and refuses an incompatible confidentiality model', async () => {
    const f = fixture()
    Object.assign(f.instance, { status: 'streaming' })
    await expect(f.instance.compactContext()).rejects.toThrow('current response')
    Object.assign(f.instance, { status: 'ready' })
    useChatStore.getState().updateSession('chat', {
      chatThread: createMockChatThread({ isEncrypted: 1 }),
      selectedModel: createMockModel({ isConfidential: 0 }),
    })
    await expect(f.instance.compactContext()).rejects.toThrow('confidentiality')
    expect(f.adapterCompact).not.toHaveBeenCalled()
  })
})
