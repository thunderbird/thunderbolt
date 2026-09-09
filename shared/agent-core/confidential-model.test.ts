/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { AgentHarness, AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, AssistantMessageEvent, Context, StreamOptions } from '@earendil-works/pi-ai'
import { inferenceUsageReceiptHeader } from '../inference-usage.ts'
import {
  buildConfidentialModel,
  createReceiptLifecycle,
  type BuildConfidentialModelOptions,
  type CompletedProviderStep,
} from './index.ts'

const context: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }

const sseResponse = (model: string, receipt?: string): Response => {
  const headers = new Headers({ 'content-type': 'text/event-stream' })
  if (receipt !== undefined) {
    headers.set(inferenceUsageReceiptHeader, receipt)
  }
  return new Response(
    [
      `data: ${JSON.stringify({
        id: 'completion',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'completion',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    { headers },
  )
}

const failedSseResponse = (receipt: string): Response =>
  new Response(
    [
      `data: ${JSON.stringify({
        id: 'completion',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'glm-5-2',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }],
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    {
      headers: {
        'content-type': 'text/event-stream',
        [inferenceUsageReceiptHeader]: receipt,
      },
    },
  )

const createReceiptRecorder = () => {
  const completed: CompletedProviderStep[] = []
  const clears: string[] = []
  return {
    completed,
    clears,
    receipts: {
      completeProviderStep: (step: CompletedProviderStep) => completed.push(step),
      clear: () => {
        clears.push('clear')
      },
    },
  }
}

const build = (overrides: Partial<BuildConfidentialModelOptions> = {}): ReturnType<typeof buildConfidentialModel> => {
  const recorder = createReceiptRecorder()
  return buildConfidentialModel({
    providerId: 'thunderbolt',
    modelId: 'glm-5-2',
    vendor: 'zhipu',
    baseURL: 'https://cloud.example/v1/tinfoil',
    apiKey: 'placeholder',
    fetch: async () => sseResponse('glm-5-2'),
    receipts: recorder.receipts,
    reasoning: true,
    contextWindow: 131_072,
    supportsImages: false,
    ...overrides,
  })
}

const providerFor = (built: ReturnType<typeof buildConfidentialModel>) => {
  const provider = built.models.getProvider('thunderbolt')
  if (!provider) {
    throw new Error('expected confidential provider')
  }
  return provider
}

const collectEvents = async (
  built: ReturnType<typeof buildConfidentialModel>,
  signal?: AbortSignal,
  onResponse?: StreamOptions['onResponse'],
): Promise<AssistantMessageEvent[]> => {
  const events: AssistantMessageEvent[] = []
  for await (const event of providerFor(built).streamSimple(built.model, context, {
    reasoning: 'high',
    signal,
    onResponse,
  })) {
    events.push(event)
  }
  return events
}

describe('buildConfidentialModel compatibility', () => {
  it.each([
    ['zhipu GLM', 'glm-5-2', 'zhipu', { type: 'enabled', clear_thinking: false }],
    ['DeepSeek V4 Flash', 'deepseek-v4-flash', 'deepseek', { type: 'enabled' }],
  ] as const)('uses catalog-driven Pi thinking metadata for %s', async (_name, modelId, vendor, thinking) => {
    const payloads: Array<{ readonly thinking?: unknown; readonly reasoning_effort?: unknown }> = []
    const built = build({
      modelId,
      vendor,
      fetch: async (_input, init) => {
        payloads.push((await new Response(init?.body).json()) as (typeof payloads)[number])
        return sseResponse(modelId)
      },
    })

    await collectEvents(built)

    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({ thinking, reasoning_effort: 'high' })
  })

  it.each([
    ['unknown vendor', 'unknown'],
    ['missing vendor', null],
  ] as const)('fails at build time for %s', (_name, vendor) => {
    expect(() => build({ modelId: 'secret-model', vendor })).toThrow(
      'Managed model "secret-model" has no Pi compatibility metadata.',
    )
  })
})

describe('buildConfidentialModel receipt capture', () => {
  it('stages the response receipt with its successful terminal message', async () => {
    const recorder = createReceiptRecorder()
    const built = build({
      receipts: recorder.receipts,
      fetch: async () => sseResponse('glm-5-2', 'signed-receipt'),
    })

    await collectEvents(built)

    expect(recorder.completed).toHaveLength(1)
    expect(recorder.completed[0]).toMatchObject({
      receipt: 'signed-receipt',
      message: { stopReason: 'stop' },
    })
    expect(recorder.clears).toEqual([])
  })

  it.each([
    ['missing header', async () => sseResponse('glm-5-2')],
    ['provider error', async () => failedSseResponse('stale-receipt')],
  ] as const)('clears receipt state after %s', async (_name, fetch) => {
    const recorder = createReceiptRecorder()
    const built = build({ receipts: recorder.receipts, fetch })

    await collectEvents(built)

    expect(recorder.completed).toEqual([])
    expect(recorder.clears).toEqual(['clear'])
  })

  it('clears receipt state after an aborted request', async () => {
    const recorder = createReceiptRecorder()
    const responseStarted = Promise.withResolvers<void>()
    const controller = new AbortController()
    const built = build({
      receipts: recorder.receipts,
      fetch: async (_input, init) => {
        const signal = init?.signal
        if (!signal) {
          throw new Error('Expected the confidential request to carry an abort signal.')
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (stream) => {
              const abort = () => stream.error(signal.reason ?? new DOMException('Aborted', 'AbortError'))
              if (signal.aborted) {
                abort()
                return
              }
              signal.addEventListener('abort', abort, { once: true })
            },
          }),
          {
            headers: {
              'content-type': 'text/event-stream',
              [inferenceUsageReceiptHeader]: 'aborted-receipt',
            },
          },
        )
      },
    })

    const events = collectEvents(built, controller.signal, () => {
      responseStarted.resolve()
    })
    await responseStarted.promise
    controller.abort()
    await events

    expect(recorder.completed).toEqual([])
    expect(recorder.clears).toEqual(['clear'])
  })

  it('restores a stable secret-free attestation failure after Pi masks the fetch error', async () => {
    const original = Object.assign(new Error('measurement mismatch: sk-live-secret'), {
      name: 'AttestationError',
    })
    const built = build({
      fetch: async () => {
        throw new Error('transport wrapper', { cause: original })
      },
    })

    const events = await collectEvents(built)
    const terminal = events.find((event) => event.type === 'error')

    expect(terminal).toMatchObject({
      type: 'error',
      error: { errorMessage: 'Confidential model attestation failed.' },
    })
    expect(JSON.stringify(events)).not.toContain('sk-live-secret')
  })
})

const assistantMessage = (stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'answer' }],
  api: 'openai-completions',
  provider: 'thunderbolt',
  model: 'glm-5-2',
  usage: {
    input: 11,
    output: 2,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 0,
})

const createHarnessEvents = () => {
  type Listener = Parameters<AgentHarness['subscribe']>[0]
  const listeners = new Set<Listener>()
  const harness: Pick<AgentHarness, 'subscribe'> = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    harness,
    emit: async (event: AgentHarnessEvent) => {
      for (const listener of listeners) {
        await listener(event)
      }
    },
  }
}

describe('createReceiptLifecycle', () => {
  it('submits one mapped receipt only for the exact terminal message', async () => {
    const submitted: unknown[] = []
    const lifecycle = createReceiptLifecycle({
      submit: async (usage) => {
        submitted.push(usage)
      },
      reportError: () => {},
    })
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const message = assistantMessage()
    const otherMessage = assistantMessage()

    lifecycle.completeProviderStep({ receipt: 'signed-receipt', message })
    await events.emit({ type: 'message_end', message: otherMessage })
    await events.emit({ type: 'message_end', message })
    await events.emit({ type: 'message_end', message })

    expect(submitted).toEqual([{ receipt: 'signed-receipt', promptTokens: 16, completionTokens: 2, totalTokens: 18 }])
  })

  it.each(['error', 'aborted'] as const)('does not submit a receipt for a %s terminal message', async (stopReason) => {
    const submitted: unknown[] = []
    const lifecycle = createReceiptLifecycle({
      submit: async (usage) => {
        submitted.push(usage)
      },
      reportError: () => {},
    })
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const message = assistantMessage(stopReason)

    lifecycle.completeProviderStep({ receipt: 'unused-receipt', message })
    await events.emit({ type: 'message_end', message })

    expect(submitted).toEqual([])
  })

  it('does not submit unsafe provider token counts', async () => {
    const submitted: unknown[] = []
    const lifecycle = createReceiptLifecycle({
      submit: async (usage) => {
        submitted.push(usage)
      },
      reportError: () => {},
    })
    const events = createHarnessEvents()
    lifecycle.attach(events.harness)
    const valid = assistantMessage()
    const message = { ...valid, usage: { ...valid.usage, input: -1 } }

    lifecycle.completeProviderStep({ receipt: 'unused-receipt', message })
    await events.emit({ type: 'message_end', message })

    expect(submitted).toEqual([])
  })
})
