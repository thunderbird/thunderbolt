/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod'
import type { PreparedAiRequestConfig } from '@/ai/fetch'
import { builtInAgent } from '@/defaults/agents'
import { createClient } from '@/lib/http'
import type { Model, ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import type { AgentAdapterContext } from '@/types/acp'
import type { CompactionStatus } from '@shared/agent-core'
import { createBuiltInAdapter } from './built-in-adapter'
import { createChatInstance } from '@/chats/chat-instance'
import { createMockChatInstance, createMockChatThread, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { CompactionCheckpoint } from '@shared/agent-core'

afterEach(resetStore)

type RequestBody = {
  messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>
}

/** Identify Pi's separate summary request in the fake provider. */
const isSummary = (request: RequestBody) =>
  JSON.stringify(request.messages[0]).includes('context summarization assistant')

/** Script just the provider's HTTP responses; everything from the adapter through Pi runs for real. */
const fixture = (
  options: {
    toolSteps?: number
    toolTokens?: number
    toolOutput?: string
    embeddedSurface?: PreparedAiRequestConfig['embeddedSurface']
    beforeResponse?: (request: RequestBody, init?: RequestInit) => Promise<void>
  } = {},
) => {
  const requests: RequestBody[] = []
  const providerRequests: RequestBody[] = []
  const status: CompactionStatus[] = []
  const model = {
    id: 'compaction-test',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test',
    toolUsage: 1,
    contextWindow: 20_000,
    isConfidential: 0,
  } as Model
  const config: PreparedAiRequestConfig = {
    model,
    profile: null,
    supportsTools: true,
    sourceCollector: [],
    mcpToolsMetadata: undefined,
    skills: [],
    stableSystemPrompt: 'Help finish the task.',
    volatileSystemPrompt: 'Today.',
    embeddedSurface: options.embeddedSurface ?? null,
    toolset: {
      lookup: tool({
        description: 'Look up detail',
        inputSchema: z.object({}),
        execute: async () => options.toolOutput ?? 'Tool evidence. '.repeat(800),
      }),
    },
  }
  const adapter = () =>
    createBuiltInAdapter(builtInAgent, { prepareConfig: async () => ({ ...config, model: context.selectedModel }) })
  const context: AgentAdapterContext = {
    threadId: crypto.randomUUID(),
    chatThread: null,
    acpSessionId: null,
    saveMessages: async () => {},
    selectedModel: model,
    mcpClients: [],
    reconnectClient: async () => null,
    httpClient: createClient({ prefixUrl: 'https://backend.test' }),
    onAcpSessionId: async () => {},
    onCompactionStatus: (value) => status.push(value),
    getProxyFetch: () =>
      Object.assign(
        async (_input: unknown, init?: RequestInit) => {
          const request = JSON.parse(String(init?.body)) as RequestBody
          requests.push(request)
          const summary = isSummary(request)
          if (!summary) {
            providerRequests.push(request)
          }
          await options.beforeResponse?.(request, init)
          const callTool = !summary && providerRequests.length <= (options.toolSteps ?? 0)
          const delta = callTool
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `lookup-${providerRequests.length}`,
                    type: 'function',
                    function: { name: 'lookup', arguments: '{}' },
                  },
                ],
              }
            : { role: 'assistant', content: summary ? '## Goal\nCondensed previous task.' : 'Finished the task.' }
          const event = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({
              id: 'completion',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-test',
              choices: [{ index: 0, delta, finish_reason }],
              ...(finish_reason
                ? {
                    usage: {
                      prompt_tokens: callTool ? (options.toolTokens ?? 16_500) : 120,
                      completion_tokens: 10,
                      total_tokens: callTool ? (options.toolTokens ?? 16_500) + 10 : 130,
                    },
                  }
                : {}),
            })}\n\n`
          return new Response(event(delta, null) + event({}, callTool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        },
        { preconnect: async () => false },
      ),
  }
  return { adapter, context, requests, providerRequests, status, config }
}

const user = (text: string): ThunderboltUIMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text }],
})
const assistant = (text: string): ThunderboltUIMessage => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  parts: [{ type: 'text', text }],
})
const body = (messages: ThunderboltUIMessage[]): RequestInit => ({ body: JSON.stringify({ messages }) })

/** Read metadata emitted at the actual SSE boundary, as the chat transport does. */
const metadata = async (response: Response): Promise<UIMessageMetadata> => {
  const chunks = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)))
  expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([])
  return Object.assign(
    {},
    ...chunks.filter((chunk) => chunk.type === 'message-metadata').map((chunk) => chunk.messageMetadata),
  )
}

describe('built-in compaction integration', () => {
  it.each(['retry', 'send'] as const)('uses durable history after a failed manual save, then %s', async (next) => {
    const f = fixture()
    const adapter = f.adapter()
    const messages = [user('Original fact'), assistant('Original answer')]
    const save = mock(async (): Promise<void> => {
      throw new Error('disk full')
    })
    const instance = createChatInstance(
      f.context.threadId,
      messages,
      save,
      f.context.httpClient,
      f.context.getProxyFetch,
      {
        getOrConnectAdapter: async () => adapter,
        createChat: () => createMockChatInstance(messages),
        trackEvent: () => {},
      },
    )
    hydrateStore({
      id: f.context.threadId,
      chatInstance: instance,
      chatThread: createMockChatThread(),
      selectedModel: f.context.selectedModel,
      triggerData: null,
    })
    try {
      await expect(instance.compactContext()).rejects.toThrow('disk full')
      expect(instance.messages.at(-1)?.metadata?.contextCompaction).toBeUndefined()
      if (next === 'retry') {
        save.mockImplementation(async () => {})
        await instance.compactContext()
        expect(instance.messages.at(-1)?.metadata?.contextCompaction?.summary).toContain('Condensed previous task')
        expect(f.requests.filter(isSummary)).toHaveLength(2)
      } else {
        await metadata(await adapter.fetch(body([...instance.messages, user('Continue')]), f.context))
        expect(JSON.stringify(f.requests.at(-1))).toContain('Original fact')
        expect(JSON.stringify(f.requests.at(-1))).not.toContain('Condensed previous task')
      }
    } finally {
      adapter.disconnect()
    }
  })

  it('rebuilds from saved history when Stop closes the stream before an automatic checkpoint is published', async () => {
    const entered = Promise.withResolvers<void>()
    const f = fixture({
      beforeResponse: async (request, init) => {
        if (isSummary(request) || f.providerRequests.length > 1) {
          return
        }
        entered.resolve()
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          })
        })
      },
    })
    const adapter = f.adapter()
    const messages = [user('Long context. '.repeat(5_000)), assistant('Prior answer'), user('Continue')]
    const controller = new AbortController()
    try {
      const response = await adapter.fetch({ ...body(messages), signal: controller.signal }, f.context)
      const result = metadata(response)
      await entered.promise
      expect(f.status).toContain('compacted')
      controller.abort()
      expect((await result).contextCompaction).toBeUndefined()
      const next = await metadata(
        await adapter.fetch(body([...messages, assistant('Stopped'), user('Go on')]), f.context),
      )
      expect(next.contextCompaction?.summary).toContain('Condensed previous task')
      expect(f.status.filter((status) => status === 'compacted')).toHaveLength(2)
    } finally {
      adapter.disconnect()
    }
  })

  it('keeps the compacted context through multiple subsequent tool requests', async () => {
    const f = fixture({ toolSteps: 2, toolTokens: 120 })
    const adapter = f.adapter()
    try {
      await metadata(
        await adapter.fetch(
          body([user('Long context. '.repeat(5_000)), assistant('Prior answer'), user('Look up both details')]),
          f.context,
        ),
      )
      expect(f.providerRequests).toHaveLength(3)
      for (const request of f.providerRequests) {
        expect(JSON.stringify(request)).toContain('Condensed previous task')
        expect(JSON.stringify(request)).not.toContain('Long context.')
      }
      const last = f.providerRequests[2].messages
      expect(last.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? [])).toEqual([
        'lookup-1',
        'lookup-2',
      ])
      expect(last.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual([
        'lookup-1',
        'lookup-2',
      ])
    } finally {
      adapter.disconnect()
    }
  })

  it.each(['manual', 'automatic'] as const)(
    'excludes superseded Mini App reads from %s summary requests',
    async (mode) => {
      const f = fixture({ embeddedSurface: 'mini-app' })
      const call = {
        ...fauxAssistantMessage(''),
        content: [{ type: 'toolCall' as const, id: 'old-view', name: 'get_app_context', arguments: {} }],
      }
      const checkpoint: CompactionCheckpoint = {
        version: 1,
        summary: 'Earlier task',
        tokensBefore: 100,
        contextTokens: 100,
        retainedTail: [
          { role: 'user', content: 'Read the old screen', timestamp: 1 },
          call,
          {
            role: 'toolResult',
            toolCallId: 'old-view',
            toolName: 'get_app_context',
            content: [{ type: 'text', text: 'STALE_PRIVATE_SCREEN' }],
            isError: false,
            timestamp: 2,
          },
          { role: 'user', content: 'Later detail. '.repeat(5_000), timestamp: 3 },
          fauxAssistantMessage('Done.'),
        ],
      }
      const transcript: ThunderboltUIMessage[] = [
        user('Earlier task'),
        {
          ...assistant('Prior answer'),
          parts: [
            {
              type: 'tool-get_app_context',
              toolCallId: 'old-view',
              state: 'output-available',
              input: {},
              output: 'STALE_PRIVATE_SCREEN',
            },
          ],
          metadata: { contextCompaction: checkpoint, embeddedSurface: 'mini-app' },
        },
      ]
      const adapter = f.adapter()
      try {
        const saved =
          mode === 'manual'
            ? await adapter.compact!(body(transcript), f.context)
            : (await metadata(await adapter.fetch(body([...transcript, user('Continue')]), f.context)))
                .contextCompaction
        const summaries = f.requests.filter(isSummary)
        expect(summaries.length).toBeGreaterThan(0)
        expect(JSON.stringify(summaries)).not.toContain('STALE_PRIVATE_SCREEN')
        expect(JSON.stringify(summaries)).toContain('Superseded')
        expect(JSON.stringify(saved)).not.toContain('STALE_PRIVATE_SCREEN')
      } finally {
        adapter.disconnect()
      }
    },
  )

  it('compacts a reloaded chat manually and restores its checkpoint on another adapter and model', async () => {
    const f = fixture()
    const transcript = [
      user('Old detail. '.repeat(4_000)),
      assistant('Old answer. '.repeat(1_000)),
      user('Recent question'),
      assistant('Recent answer'),
    ]
    const first = f.adapter()
    const checkpoint = await first.compact!(body(transcript), f.context, 'Preserve the decisions')
    expect(JSON.stringify(f.requests)).toContain('Preserve the decisions')
    expect(checkpoint.contextTokens).toBeLessThan(checkpoint.tokensBefore)
    transcript[3] = { ...transcript[3], metadata: { contextCompaction: JSON.parse(JSON.stringify(checkpoint)) } }
    f.context.selectedModel = { ...f.context.selectedModel, model: 'another-model' }
    const second = f.adapter()
    const result = await metadata(await second.fetch(body([...transcript, user('Continue')]), f.context))
    expect(JSON.stringify(f.requests.at(-1))).toContain('Condensed previous task')
    expect(JSON.stringify(f.requests.at(-1))).not.toContain('Old detail.')
    expect(result.contextCompaction).toBeUndefined()
    expect(result.contextTokens).toBeUndefined()
    expect(result.usage?.totalTokens).toBe(130)
    first.disconnect()
    second.disconnect()
  })

  it('automatically compacts before a request and emits a durable checkpoint in the assistant metadata', async () => {
    const f = fixture()
    const adapter = f.adapter()
    const result = await metadata(
      await adapter.fetch(
        body([user('Long context. '.repeat(5_000)), assistant('Prior answer'), user('Next task')]),
        f.context,
      ),
    )
    expect(f.status).toEqual(['compacting', 'compacted'])
    expect(result.contextCompaction?.summary).toContain('Condensed previous task')
    expect(result.contextCompaction?.retainedTail.at(-1)?.role).toBe('assistant')
    expect(JSON.stringify(f.requests.at(-1))).not.toContain('Long context.')
    expect(JSON.stringify(f.requests.at(-1))).toContain('Next task')
    adapter.disconnect()
  })

  it('compacts between tool steps without orphaning a tool result or losing the final checkpoint', async () => {
    const f = fixture({ toolSteps: 1, toolOutput: 'Tool evidence. '.repeat(100) })
    const adapter = f.adapter()
    const result = await metadata(
      await adapter.fetch(
        body([
          user('Earlier task'),
          assistant('Earlier detail. '.repeat(1_000)),
          user('Look up the detail and finish'),
        ]),
        f.context,
      ),
    )
    expect(f.status).toEqual(['compacting', 'compacted'])
    expect(f.requests.length).toBeGreaterThanOrEqual(3)
    const finalMessages = f.requests.at(-1)!.messages
    const callIds = finalMessages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? [])
    const resultIds = finalMessages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)
    expect(callIds).toEqual(['lookup-1'])
    expect(resultIds).toEqual(callIds)
    expect(result.contextCompaction?.retainedTail.at(-1)?.role).toBe('assistant')
    expect(result.contextTokens).toBe(130)
    adapter.disconnect()
  })
})
