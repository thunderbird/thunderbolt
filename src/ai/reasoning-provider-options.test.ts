/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { JSONValue } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { reasoningProviderOptions } from './reasoning-provider-options'

describe('legacy reasoning provider options', () => {
  it('preserves OpenRouter output preferences while replacing conflicting budgets', () => {
    const profile = {
      reasoning: { exclude: true, max_tokens: 1000, enabled: false },
      reasoningEffort: 'low',
      user: 'test',
    }
    expect(reasoningProviderOptions(profile, 'openrouter', 'high', false)).toEqual({
      user: 'test',
      reasoning: { exclude: true, effort: 'high' },
    })
    expect(profile.reasoning.max_tokens).toBe(1000)
  })
  it.each([null, false, ['high']] as JSONValue[])('replaces non-object reasoning configuration (%j)', (reasoning) => {
    expect(reasoningProviderOptions({ reasoning }, 'openrouter', 'none', false)).toEqual({
      reasoning: { effort: 'none' },
    })
  })
  it('uses the SDK camel-case key for OpenAI and removes stale alternative controls', () => {
    expect(
      reasoningProviderOptions(
        { thinking: { type: 'enabled' }, reasoning_effort: 'high', effort: 'high', user: 'test' },
        'openai',
        'none',
        false,
      ),
    ).toEqual({ user: 'test', reasoningEffort: 'none' })
  })
  it('retains adaptive Anthropic reasoning visibility when changing effort', () => {
    const profile = { thinking: { type: 'adaptive', display: 'summarized', budgetTokens: 4096 }, effort: 'low' }
    expect(reasoningProviderOptions(profile, 'anthropic', 'high', false)).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
    })
    expect(profile.thinking.budgetTokens).toBe(4096)
    expect(reasoningProviderOptions(profile, 'anthropic', 'none', false)).toEqual({ thinking: { type: 'disabled' } })
  })
  it.each([
    ['none', false, { thinking: { type: 'disabled' } }],
    ['high', true, { thinking: { type: 'enabled', budgetTokens: 4096 } }],
    ['max', false, { thinking: { type: 'adaptive' }, effort: 'max' }],
  ] as const)('translates Anthropic %s with budget-only=%s', (effort, budgetOnly, expected) => {
    expect(reasoningProviderOptions({}, 'anthropic', effort, budgetOnly)).toEqual(expected)
  })
})

it.each(['anthropic', 'openrouter', 'openai', 'openai-chat'] as const)(
  'serializes effort under the actual %s SDK namespace',
  async (transport) => {
    const provider = transport === 'openai-chat' ? 'openai' : transport
    const payloads: Record<string, unknown>[] = []
    const fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        payloads.push((await new Request(input, init).json()) as Record<string, unknown>)
        throw new Error('request captured')
      },
      { preconnect: () => {} },
    )
    const model =
      provider === 'anthropic'
        ? createAnthropic({ apiKey: 'test', fetch })('claude-opus-5')
        : provider === 'openrouter'
          ? createOpenAICompatible({
              name: 'openrouter',
              baseURL: 'https://openrouter.invalid/v1',
              apiKey: 'test',
              fetch,
            })('test/model')
          : transport === 'openai-chat'
            ? createOpenAI({ apiKey: 'test', fetch }).chat('gpt-5.5')
            : createOpenAI({ apiKey: 'test', fetch })('gpt-5.5')
    const profile = {
      thinking: { type: 'adaptive', display: 'summarized' },
      reasoning: { exclude: true, max_tokens: 4096 },
    }
    await expect(
      model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        providerOptions: { [provider]: reasoningProviderOptions(profile, provider, 'high', false) },
      }),
    ).rejects.toThrow('request captured')
    expect(payloads).toHaveLength(1)
    const payload = payloads[0]!
    if (provider === 'anthropic') {
      expect(payload.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
      expect(payload.output_config).toEqual({ effort: 'high' })
    } else if (provider === 'openrouter') {
      expect(payload.reasoning).toEqual({ exclude: true, effort: 'high' })
      expect(payload.reasoning_effort).toBeUndefined()
    } else if (transport === 'openai-chat') {
      expect(payload.reasoning_effort).toBe('high')
    } else {
      expect(payload.reasoning).toMatchObject({ effort: 'high' })
    }
  },
)

it.each([undefined, 'high', 'none'] as const)(
  'preserves a native Anthropic budget unless the user chooses %s',
  async (effort) => {
    const payloads: Record<string, unknown>[] = []
    const fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        payloads.push((await new Request(input, init).json()) as Record<string, unknown>)
        throw new Error('request captured')
      },
      { preconnect: () => {} },
    )
    const model = createAnthropic({ apiKey: 'test', fetch })('claude-sonnet-4-5')
    const profile = { thinking: { type: 'enabled', budgetTokens: 16384 } }
    await expect(
      model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        providerOptions: { anthropic: reasoningProviderOptions(profile, 'anthropic', effort, true) },
      }),
    ).rejects.toThrow('request captured')
    expect(payloads).toHaveLength(1)
    expect(payloads[0]!.thinking).toEqual(
      effort === 'none' ? undefined : { type: 'enabled', budget_tokens: effort === undefined ? 16384 : 4096 },
    )
    expect(profile.thinking.budgetTokens).toBe(16384)
  },
)

it.each([{ enabled: false }, { enabled: true }, { max_tokens: 16384 }])(
  'preserves native OpenRouter reasoning %j when no override was selected',
  async (reasoning) => {
    const payloads: Record<string, unknown>[] = []
    const fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        payloads.push((await new Request(input, init).json()) as Record<string, unknown>)
        throw new Error('request captured')
      },
      { preconnect: () => {} },
    )
    const model = createOpenAICompatible({
      name: 'openrouter',
      baseURL: 'https://openrouter.invalid/v1',
      apiKey: 'test',
      fetch,
    })('test/model')
    await expect(
      model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        providerOptions: { openrouter: reasoningProviderOptions({ reasoning }, 'openrouter', undefined, false) },
      }),
    ).rejects.toThrow('request captured')
    expect(payloads).toHaveLength(1)
    expect(payloads[0]!.reasoning).toEqual(reasoning)
    expect(payloads[0]!.reasoning_effort).toBeUndefined()
  },
)
