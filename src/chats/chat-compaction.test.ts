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
  const instance = createChatInstance(
    'chat',
    messages,
    saved,
    createClient({ prefixUrl: 'https://backend.test' }),
    () => Object.assign(async () => new Response(), { preconnect: async () => false }),
    {
      getOrConnectAdapter: async () => adapter,
      createChat: () => createMockChatInstance(messages),
      trackEvent: () => {},
    },
  )
  hydrateStore({
    id: 'chat',
    chatInstance: instance,
    chatThread: createMockChatThread(),
    selectedModel: createMockModel(),
    triggerData: null,
  })
  return { instance, saved, adapterCompact, adapter, messages }
}

describe('chat compaction control', () => {
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
