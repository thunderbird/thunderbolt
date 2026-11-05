/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { http } from '@/lib/http'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { getChatReasoningEffort, loadReasoningCapabilities } from './reasoning-effort'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { updateSettings } from '@/dal/settings'
import { getDb } from '@/db/database'
import { reasoningEffortSettingKey } from '@shared/reasoning-effort'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

it('shares OpenRouter discovery, retries cold failures, and retains known capabilities during refresh outages', async () => {
  const clock = getClock()
  clock.setSystemTime(1)
  const request = spyOn(http, 'get')
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const first = createMockModel({ provider: 'openrouter', model: 'test/one' })
  const second = createMockModel({ provider: 'openrouter', model: 'test/two' })
  const response = (body: unknown) => {
    const value = new Response(JSON.stringify(body))
    return Object.assign(Promise.resolve(value), {
      json: <T>() => value.clone().json() as Promise<T>,
      text: () => value.clone().text(),
    })
  }
  try {
    const pending = Promise.withResolvers<unknown>()
    request.mockImplementation(() => Object.assign(response({}), { json: <T>() => pending.promise as Promise<T> }))
    const coldRequest = loadReasoningCapabilities(first)
    clock.setSystemTime(300_002)
    const sharedRequest = loadReasoningCapabilities(second)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenLastCalledWith('https://openrouter.ai/api/v1/models', { timeout: 10_000 })
    const failures = Promise.allSettled([coldRequest, sharedRequest])
    pending.resolve({ invalid: true })
    expect((await failures).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    clock.setSystemTime(1)
    request.mockImplementation(() =>
      response({
        data: [
          { id: 'test/one', reasoning: { supported_efforts: ['low', 'high'] } },
          { id: 'test/two', reasoning: { supported_efforts: null, mandatory: true } },
        ],
      }),
    )
    const [one, two] = await Promise.all([loadReasoningCapabilities(first), loadReasoningCapabilities(second)])
    expect(one.efforts).toEqual(['low', 'high'])
    expect(two.efforts).not.toContain('none')
    expect(two.efforts).toContain('max')
    expect(request).toHaveBeenCalledTimes(2)
    clock.setSystemTime(300_002)
    request.mockImplementation(() => response({ invalid: true }))
    expect((await loadReasoningCapabilities(first)).efforts).toEqual(['low', 'high'])
    expect(request).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
    clock.setSystemTime(600_003)
    request.mockImplementation(() =>
      response({ data: [{ id: 'test/one', reasoning: { supported_efforts: ['medium'] } }] }),
    )
    expect((await loadReasoningCapabilities(first)).efforts).toEqual(['medium'])
    expect((await loadReasoningCapabilities(second)).efforts).toEqual([])
    expect(request).toHaveBeenCalledTimes(4)
  } finally {
    request.mockRestore()
    warn.mockRestore()
  }
})

it('reads only valid, currently supported per-chat/model effort preferences at send time', async () => {
  const model = createMockModel({ id: 'saved-effort', provider: 'tinfoil', model: 'glm-5-3' })
  const key = reasoningEffortSettingKey('saved-chat', model.id)
  expect(await getChatReasoningEffort('saved-chat', model)).toBeUndefined()
  await updateSettings(getDb(), { [key]: 'invalid' })
  expect(await getChatReasoningEffort('saved-chat', model)).toBeUndefined()
  await updateSettings(getDb(), { [key]: 'none' })
  expect(await getChatReasoningEffort('saved-chat', model)).toBeUndefined()
  await updateSettings(getDb(), { [key]: 'max' })
  expect(await getChatReasoningEffort('saved-chat', model)).toBe('max')
  expect(await getChatReasoningEffort('other-chat', model)).toBeUndefined()
  expect(await getChatReasoningEffort('saved-chat', { ...model, id: 'other-model' })).toBeUndefined()
  expect(await getChatReasoningEffort('saved-chat', { ...model, model: 'llama3-3-70b' })).toBeUndefined()
})

it.each([
  { provider: 'openai', vendor: null, model: 'gpt-5.5', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { provider: 'thunderbolt', vendor: 'openai', model: 'gpt-5.5', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  {
    provider: 'anthropic',
    vendor: null,
    model: 'claude-opus-5',
    efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    provider: 'thunderbolt',
    vendor: 'anthropic',
    model: 'opus-5-5',
    efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  { provider: 'thunderbolt', vendor: 'anthropic', model: 'sonnet-4-5', efforts: ['none', 'high'], kind: 'toggle' },
  { provider: 'anthropic', vendor: null, model: 'claude-sonnet-4-5', efforts: ['none', 'high'], kind: 'toggle' },
])(
  'resolves serving-provider catalog capabilities for $provider/$model',
  async ({ provider, vendor, model, efforts, kind }) => {
    const capabilities = await loadReasoningCapabilities(createMockModel({ provider, vendor, model }))
    expect(capabilities.efforts).toEqual(efforts)
    expect(capabilities.kind).toBe(kind)
  },
)

it.each([
  { provider: 'custom', vendor: 'openai', model: 'gpt-5.5' },
  { provider: 'thunderbolt', vendor: 'unknown', model: 'gpt-5.5' },
  { provider: 'thunderbolt', vendor: null, model: 'gpt-5.5' },
  { provider: 'openai', vendor: null, model: 'not-in-catalog' },
  { provider: 'anthropic', vendor: null, model: 'not-in-catalog' },
])('does not infer support for an unknown serving provider or model ($provider/$model)', async (model) => {
  expect((await loadReasoningCapabilities(createMockModel(model))).efforts).toEqual([])
})
