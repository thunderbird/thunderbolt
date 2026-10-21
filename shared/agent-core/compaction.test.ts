/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { AgentHarness, estimateContextTokens, InMemorySessionRepo } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { buildOpenAiCompatModel, type OpenAiCompatFetch } from './openai-compat-model.ts'
import {
  createHarnessCompaction,
  restoreCompaction,
  type CompactionCheckpoint,
  type CompactionStatus,
} from './compaction.ts'

/** Exercise Pi's real summarizer, serialization and session storage through a local provider fixture. */
const fixture = async (fetchOverride?: OpenAiCompatFetch) => {
  const requests: string[] = []
  const response = () =>
    new Response(
      [
        'data: {"id":"summary","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"## Goal\\nKeep the project decisions."},"finish_reason":null}]}',
        'data: {"id":"summary","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":600,"completion_tokens":20,"total_tokens":620}}',
        'data: [DONE]',
        '',
      ].join('\n\n'),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  const { models, model } = buildOpenAiCompatModel({
    providerId: 'openai',
    modelId: 'test',
    baseURL: 'https://compaction.test/v1',
    apiKey: 'test',
    reasoning: false,
    supportsImages: true,
    contextWindow: 10_000,
    fetch: async (input, init) => {
      requests.push(String(init?.body))
      return fetchOverride ? fetchOverride(input, init) : response()
    },
  })
  const session = await new InMemorySessionRepo().create({})
  const harness = new AgentHarness({ session, models, model, thinkingLevel: 'off', systemPrompt: 'Help.' })
  const compaction = createHarnessCompaction(harness, session)
  const seed = async (tokens: number) => {
    await harness.appendMessage({ role: 'user', content: 'Old project detail. '.repeat(800), timestamp: 1 })
    await harness.appendMessage(fauxAssistantMessage('Old decisions. '.repeat(500)))
    await harness.appendMessage({ role: 'user', content: 'Keep working on the current task.', timestamp: 3 })
    const assistant = fauxAssistantMessage('Current response.')
    assistant.usage = {
      ...assistant.usage,
      input: Math.max(0, tokens - 10),
      output: Math.min(tokens, 10),
      totalTokens: tokens,
    }
    await harness.appendMessage(assistant)
  }
  return { session, harness, compaction, requests, seed }
}

describe('Pi context compaction', () => {
  it('omits image binaries only from the durable copy, across user, tool and custom messages', async () => {
    const f = await fixture()
    const image = { type: 'image' as const, data: 'LOCAL_IMAGE_BYTES', mimeType: 'image/png' }
    const original: CompactionCheckpoint = {
      version: 1,
      summary: 'Saved task',
      tokensBefore: 100,
      contextTokens: 50,
      retainedTail: [
        { role: 'user', content: [{ type: 'text', text: 'Question about image' }, image], timestamp: 1 },
        {
          role: 'toolResult',
          toolName: 'read',
          toolCallId: 'read-image',
          content: [image],
          isError: false,
          timestamp: 2,
        },
        { role: 'custom', customType: 'attachment', content: [image], display: true, timestamp: 3 },
      ],
    }
    await restoreCompaction(f.session, original)
    const compaction = createHarnessCompaction(f.harness, f.session, original)
    const checkpoint = await compaction.checkpoint()
    expect(JSON.stringify(checkpoint)).not.toContain('LOCAL_IMAGE_BYTES')
    expect(checkpoint?.retainedTail.map((message) => 'content' in message && message.content)).toEqual([
      [
        { type: 'text', text: 'Question about image' },
        { type: 'text', text: '[Image omitted from saved context]' },
      ],
      [{ type: 'text', text: '[Image omitted from saved context]' }],
      [{ type: 'text', text: '[Image omitted from saved context]' }],
    ])
    expect(JSON.stringify((await f.session.buildContext()).messages)).toContain('LOCAL_IMAGE_BYTES')
    expect(image.data).toBe('LOCAL_IMAGE_BYTES')
    const restored = await fixture()
    await restoreCompaction(restored.session, JSON.parse(JSON.stringify(checkpoint)))
    expect(JSON.stringify((await restored.session.buildContext()).messages)).not.toContain('LOCAL_IMAGE_BYTES')
  })

  it('summarizes with custom instructions and preserves recent messages and the original history', async () => {
    const f = await fixture()
    await f.seed(8_100)
    const original = await f.session.getEntries()
    const checkpoint = await f.compaction.compact({ instructions: 'Preserve all project decisions' })
    expect(f.requests.join('\n')).toContain('Preserve all project decisions')
    expect(checkpoint.summary).toContain('Keep the project decisions')
    expect(checkpoint.contextTokens).toBeLessThan(8_100)
    expect(checkpoint.retainedTail.some((message) => message.role === 'user')).toBe(true)
    expect((await f.session.getEntries()).slice(0, original.length)).toEqual(original)
    const context = await f.session.buildContext()
    expect(context.messages[0].role).toBe('compactionSummary')
    expect(JSON.stringify(context.messages)).not.toContain('Old project detail.')
  })

  it.each([7_999, 8_000, 8_001])('checks the 80%% boundary at %i tokens', async (tokens) => {
    const f = await fixture()
    await f.seed(tokens)
    const { messages } = await f.session.buildContext()
    await f.compaction.prepareRequest(messages, {})
    expect(f.requests.length > 0).toBe(tokens >= 8_000)
  })

  it('counts system and tool overhead and does not immediately recompact retained usage', async () => {
    const f = await fixture()
    await f.seed(0)
    const { messages } = await f.session.buildContext()
    const overheadTokens = 8_000 - estimateContextTokens(messages).tokens
    const compacted = await f.compaction.prepareRequest(messages, { overheadTokens })
    const calls = f.requests.length
    await f.compaction.prepareRequest(compacted, { overheadTokens })
    expect(calls).toBeGreaterThan(0)
    expect(f.requests).toHaveLength(calls)
  })

  it('does not double-count overhead already included in provider usage', async () => {
    const f = await fixture()
    await f.seed(7_900)
    await f.compaction.prepareRequest((await f.session.buildContext()).messages, { overheadTokens: 2_000 })
    expect(f.requests).toHaveLength(0)
  })

  it('can compact a short conversation manually, including the custom instructions', async () => {
    const f = await fixture()
    await f.harness.appendMessage({ role: 'user', content: 'Remember my preference', timestamp: 1 })
    await f.harness.appendMessage(fauxAssistantMessage('I will.'))
    const checkpoint = await f.compaction.compact({ instructions: 'Keep preferences' })
    expect(f.requests.join('\n')).toContain('Remember my preference')
    expect(f.requests.join('\n')).toContain('Keep preferences')
    expect(checkpoint.retainedTail).toEqual([])
  })

  it('does not summarize away a fresh request when only prompt overhead crosses the threshold', async () => {
    const f = await fixture()
    await f.harness.appendMessage({ role: 'user', content: 'Repeat this exactly: 12345', timestamp: 1 })
    const { messages } = await f.session.buildContext()
    expect(await f.compaction.prepareRequest(messages, { overheadTokens: 8_000 })).toEqual(messages)
    expect(f.requests).toHaveLength(0)
    expect(f.compaction.revision).toBe(0)
    await expect(f.compaction.prepareRequest(messages, { overheadTokens: 10_000 })).rejects.toThrow('Context length')
    expect(f.requests).toHaveLength(0)
  })

  it('restores a durable checkpoint and includes its retained context in another compaction', async () => {
    const f = await fixture()
    await f.seed(8_100)
    const checkpoint = JSON.parse(JSON.stringify(await f.compaction.compact()))
    const restored = await fixture()
    await restoreCompaction(restored.session, checkpoint)
    const controller = createHarnessCompaction(restored.harness, restored.session, checkpoint)
    await restored.harness.appendMessage({ role: 'user', content: 'Continue tomorrow', timestamp: 5 })
    await restored.harness.appendMessage(fauxAssistantMessage('Of course.'))
    await controller.compact()
    expect(restored.requests.join('\n')).toContain('Keep the project decisions')
    expect(restored.requests.join('\n')).toContain('Keep working on the current task')
    expect(restored.requests.join('\n')).toContain('Continue tomorrow')
    expect(restored.requests.join('\n')).not.toContain('Old project detail.')
  })

  it('does not mutate session history when summary generation fails', async () => {
    const f = await fixture(async () => new Response('unavailable', { status: 503 }))
    await f.seed(8_100)
    const before = await f.session.getEntries()
    const status: CompactionStatus[] = []
    await expect(f.compaction.compact({ onStatus: (value) => status.push(value) })).rejects.toThrow()
    expect(await f.session.getEntries()).toEqual(before)
    expect(await f.compaction.checkpoint()).toBeUndefined()
    expect(status).toEqual(['compacting', 'idle'])
  })

  it('preserves the previous summary when the next cut contains only a turn prefix', async () => {
    const f = await fixture()
    const checkpoint: CompactionCheckpoint = {
      version: 1,
      summary: 'Prior decision: preserve the payment protocol.',
      tokensBefore: 8_000,
      contextTokens: 20,
      retainedTail: [],
    }
    await restoreCompaction(f.session, checkpoint)
    await f.harness.appendMessage({ role: 'user', content: 'Implement the next step.', timestamp: 1 })
    await f.harness.appendMessage(fauxAssistantMessage('Recent implementation detail. '.repeat(200)))
    const controller = createHarnessCompaction(f.harness, f.session, checkpoint)
    const next = await controller.compact()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toContain(checkpoint.summary)
    expect(f.requests[0]).toContain('Implement the next step.')
    expect(next.retainedTail).toHaveLength(1)
  })

  it('surfaces oversized retained context after one compaction attempt', async () => {
    const f = await fixture()
    await f.harness.appendMessage({ role: 'user', content: 'Analyze the result.', timestamp: 1 })
    await f.harness.appendMessage(fauxAssistantMessage('Large retained result. '.repeat(2_200)))
    await expect(f.compaction.prepareRequest((await f.session.buildContext()).messages, {})).rejects.toThrow(
      'Context length still exceeds',
    )
    expect(f.requests).toHaveLength(1)
  })

  it('cancels the real summary request, rejects overlapping compaction and preserves history', async () => {
    const started = Promise.withResolvers<void>()
    const f = await fixture(async (_input, init) => {
      started.resolve()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    })
    await f.seed(8_100)
    const before = await f.session.getEntries()
    const status: CompactionStatus[] = []
    const pending = f.compaction.compact({ onStatus: (value) => status.push(value) })
    await started.promise
    await expect(f.compaction.compact()).rejects.toThrow('already running')
    f.compaction.abort()
    await expect(pending).rejects.toThrow()
    expect(await f.session.getEntries()).toEqual(before)
    expect(status).toEqual(['compacting', 'idle'])
  })

  it('refuses an empty session without sending a summary request', async () => {
    const f = await fixture()
    await expect(f.compaction.compact()).rejects.toThrow('Nothing to compact')
    expect(f.requests).toHaveLength(0)
  })
})
