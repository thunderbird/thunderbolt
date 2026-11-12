/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai'
import { buildConfidentialModel, type BuildConfidentialModelOptions } from './index.ts'
import { resolveConfidentialModelCompatibility } from './confidential-model.ts'

const context: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }

const sseResponse = (model: string): Response =>
  new Response(
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
    { headers: { 'content-type': 'text/event-stream' } },
  )

const build = (overrides: Partial<BuildConfidentialModelOptions> = {}): ReturnType<typeof buildConfidentialModel> =>
  buildConfidentialModel({
    providerId: 'thunderbolt',
    modelId: 'glm-5-2',
    vendor: 'zhipu',
    baseURL: 'https://cloud.example/v1/tinfoil',
    apiKey: 'placeholder',
    fetch: async () => sseResponse('glm-5-2'),
    reasoning: true,
    contextWindow: 131_072,
    supportsImages: false,
    ...overrides,
  })

const providerFor = (built: ReturnType<typeof buildConfidentialModel>) => {
  const provider = built.models.getProvider('thunderbolt')
  if (!provider) {
    throw new Error('expected confidential provider')
  }
  return provider
}

const collectEvents = async (built: ReturnType<typeof buildConfidentialModel>): Promise<AssistantMessageEvent[]> => {
  const events: AssistantMessageEvent[] = []
  for await (const event of providerFor(built).streamSimple(built.model, context, { reasoning: 'high' })) {
    events.push(event)
  }
  return events
}

describe('buildConfidentialModel compatibility', () => {
  it.each(['low', 'high'] as const)(
    'preserves the catalog output budget for DeepSeek reasoning %s',
    async (reasoning) => {
      const payloads: Record<string, unknown>[] = []
      const metadata = resolveConfidentialModelCompatibility({ modelId: 'deepseek-v4-1-flash', vendor: 'deepseek' })
      const built = build({
        modelId: 'deepseek-v4-1-flash',
        vendor: 'deepseek',
        contextWindow: undefined,
        fetch: async (_input, init) => {
          payloads.push((await new Response(init?.body).json()) as Record<string, unknown>)
          return sseResponse('deepseek-v4-1-flash')
        },
      })

      await providerFor(built).streamSimple(built.model, context, { reasoning }).result()

      expect(built.model.contextWindow).toBe(metadata.contextWindow)
      expect(built.model.maxTokens).toBe(metadata.maxTokens)
      expect(payloads).toHaveLength(1)
      expect(payloads[0].max_tokens ?? payloads[0].max_completion_tokens).toBe(metadata.maxTokens)
    },
  )

  it('fits the output budget within a smaller deployment context window', async () => {
    const payloads: Record<string, unknown>[] = []
    const built = build({
      modelId: 'deepseek-v4-1-flash',
      vendor: 'deepseek',
      contextWindow: 32_000,
      fetch: async (_input, init) => {
        payloads.push((await new Response(init?.body).json()) as Record<string, unknown>)
        return sseResponse('deepseek-v4-1-flash')
      },
    })

    await providerFor(built).streamSimple(built.model, context, { reasoning: 'high' }).result()

    const budget = payloads[0].max_tokens ?? payloads[0].max_completion_tokens
    expect(built.model.contextWindow).toBe(32_000)
    expect(budget).toBeGreaterThan(8_192)
    expect(budget).toBeLessThan(32_000)
  })

  it.each([
    ['zhipu GLM', 'glm-5-2', 'zhipu', { type: 'enabled', clear_thinking: false }, 'high'],
    ['GLM 5.3', 'glm-5-3', 'zhipu', { type: 'enabled', clear_thinking: false }, 'max'],
    ['legacy GLM 5.3 Flash', 'glm-5-3-flash', 'zhipu', { type: 'enabled', clear_thinking: false }, 'low'],
    ['DeepSeek V4 Flash', 'deepseek-v4-flash', 'deepseek', { type: 'enabled' }, 'high'],
  ] as const)(
    'uses catalog-driven Pi thinking metadata for %s',
    async (_name, modelId, vendor, thinking, reasoning) => {
      const payloads: Array<{ readonly thinking?: unknown; readonly reasoning_effort?: unknown }> = []
      const built = build({
        modelId,
        vendor,
        fetch: async (_input, init) => {
          payloads.push((await new Response(init?.body).json()) as (typeof payloads)[number])
          return sseResponse(modelId)
        },
      })

      await providerFor(built).streamSimple(built.model, context, { reasoning }).result()

      expect(payloads).toHaveLength(1)
      expect(payloads[0]).toMatchObject({ model: modelId, thinking, reasoning_effort: reasoning })
    },
  )

  // Tinfoil's `reasoning_params` for DeepSeek V4.1 Flash: effort_map low→low,
  // medium→high, high→xhigh under `chat_template_kwargs`, `{ thinking: false }` off.
  it.each([
    ['off', undefined, { thinking: false }],
    ['minimal', 'minimal', { thinking: true, reasoning_effort: 'low' }],
    ['low', 'low', { thinking: true, reasoning_effort: 'low' }],
    ['medium', 'medium', { thinking: true, reasoning_effort: 'high' }],
    ['high', 'high', { thinking: true, reasoning_effort: 'xhigh' }],
    ['xhigh', 'xhigh', { thinking: true, reasoning_effort: 'xhigh' }],
    ['max', 'max', { thinking: true, reasoning_effort: 'xhigh' }],
  ] as const)(
    'sends DeepSeek V4.1 Flash reasoning %s as Tinfoil chat_template_kwargs',
    async (_name, reasoning, kwargs) => {
      const payloads: unknown[] = []
      const built = build({
        modelId: 'deepseek-v4-1-flash',
        vendor: 'deepseek',
        fetch: async (_input, init) => {
          payloads.push(await new Response(init?.body).json())
          return sseResponse('deepseek-v4-1-flash')
        },
      })

      await providerFor(built).streamSimple(built.model, context, { reasoning }).result()

      expect(payloads).toHaveLength(1)
      expect(payloads[0]).toMatchObject({ model: 'deepseek-v4-1-flash', chat_template_kwargs: kwargs })
      expect(payloads[0]).not.toHaveProperty('thinking')
      expect(payloads[0]).not.toHaveProperty('reasoning_effort')
    },
  )

  it.each([
    ['unknown vendor', 'unknown'],
    ['missing vendor', null],
  ] as const)('fails at build time for %s', (_name, vendor) => {
    expect(() => build({ modelId: 'secret-model', vendor })).toThrow(
      'Managed model "secret-model" has no Pi compatibility metadata.',
    )
  })
})

describe('buildConfidentialModel attestation failures', () => {
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
