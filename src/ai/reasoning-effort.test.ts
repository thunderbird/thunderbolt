/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { http } from '@/lib/http'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import {
  createReasoningCapabilitiesLoader,
  getChatReasoningEffort,
  loadReasoningCapabilities,
} from './reasoning-effort'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { updateSettings } from '@/dal/settings'
import { getDb } from '@/db/database'
import { reasoningEffortSettingKey } from '@shared/reasoning-effort'

const response = (body: unknown) => {
  const value = new Response(JSON.stringify(body))
  return Object.assign(Promise.resolve(value), {
    json: <T>() => value.clone().json() as Promise<T>,
    text: () => value.clone().text(),
  })
}

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

it.each(['openrouter', 'tinfoil'])(
  'shares %s discovery, retries cold failures, and retains known capabilities during refresh outages',
  async (provider) => {
    const clock = getClock()
    const loadReasoningCapabilities = createReasoningCapabilitiesLoader()
    clock.setSystemTime(1)
    const timeoutController = new AbortController()
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    const bodyStarted = Promise.withResolvers<void>()
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const request = input as Request
          return new Response(
            new ReadableStream({
              start(controller) {
                request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true })
                bodyStarted.resolve()
              },
            }),
          )
        },
        { preconnect: () => {} },
      ),
    )
    const request = spyOn(http, 'get')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const first = createMockModel({ provider, model: 'test/one' })
    const second = createMockModel({ provider, model: 'test/two' })

    try {
      const coldRequest = loadReasoningCapabilities(first)
      await bodyStarted.promise
      await request.mock.results[0].value
      clock.setSystemTime(300_002)
      const sharedRequest = loadReasoningCapabilities(second)
      expect(request).toHaveBeenCalledTimes(1)
      expect(timeout).toHaveBeenLastCalledWith(10_000)
      const failures = Promise.allSettled([coldRequest, sharedRequest])
      timeoutController.abort(new DOMException('Request timed out', 'TimeoutError'))
      expect((await failures).map((result) => result.status)).toEqual(['rejected', 'rejected'])
      clock.setSystemTime(1)
      request.mockImplementation(() =>
        response({
          data: [
            {
              id: 'test/one',
              ...(provider === 'openrouter'
                ? { reasoning: { supported_efforts: ['low', 'high'] } }
                : { reasoning: true, supported_efforts: ['low', 'high'] }),
            },
            {
              id: 'test/two',
              ...(provider === 'openrouter'
                ? { reasoning: { supported_efforts: null, mandatory: true } }
                : { reasoning: true, supported_efforts: ['low', 'high', 'max'] }),
            },
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
        response({
          data: [
            {
              id: 'test/one',
              ...(provider === 'openrouter'
                ? { reasoning: { supported_efforts: ['medium'] } }
                : { reasoning: true, supported_efforts: ['medium'] }),
            },
          ],
        }),
      )
      expect((await loadReasoningCapabilities(first)).efforts).toEqual(['medium'])
      expect((await loadReasoningCapabilities(second)).efforts).toEqual([])
      expect(request).toHaveBeenCalledTimes(4)
    } finally {
      request.mockRestore()
      fetch.mockRestore()
      timeout.mockRestore()
      warn.mockRestore()
    }
  },
)

it('reads only valid, currently supported per-chat/model effort preferences at send time', async () => {
  const model = createMockModel({ id: 'saved-effort', provider: 'tinfoil', model: 'glm-5-3' })
  const key = reasoningEffortSettingKey('saved-chat', model.id)
  const request = spyOn(http, 'get').mockImplementation(() =>
    response({
      data: [{ id: 'glm-5-3', reasoning: true, supported_efforts: ['low', 'high', 'max'] }],
    }),
  )
  try {
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
  } finally {
    request.mockRestore()
  }
})

it.each(['openrouter', 'tinfoil'])(
  'keeps a saved %s choice when discovery fails before any catalog has loaded',
  async (provider) => {
    const model = createMockModel({ id: 'router-outage', provider, model: 'test/outage' })
    const lookup = createReasoningCapabilitiesLoader()
    const readEffort = (threadId: string) => getChatReasoningEffort(threadId, model, lookup)
    const key = reasoningEffortSettingKey('router-outage-chat', model.id)
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async () => {
          throw new Error('Catalog unavailable')
        },
        { preconnect: () => {} },
      ),
    )
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await updateSettings(getDb(), { [key]: 'high' })
      expect(await readEffort('router-outage-chat')).toBe('high')
      await updateSettings(getDb(), { [key]: 'none' })
      expect(await readEffort('router-outage-chat')).toBe('none')
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledTimes(2)
      await updateSettings(getDb(), { [key]: 'invalid' })
      expect(await readEffort('router-outage-chat')).toBeUndefined()
      expect(await readEffort('unsaved-chat')).toBeUndefined()
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      fetch.mockRestore()
      warn.mockRestore()
    }
  },
)

it('keeps provider catalogs isolated and discovers a new Tinfoil model without bundled IDs', async () => {
  const load = createReasoningCapabilitiesLoader()
  const request = spyOn(http, 'get').mockImplementation((url) =>
    response({
      data: [
        {
          id: 'new-model',
          ...(String(url).includes('tinfoil')
            ? { reasoning: true, supported_efforts: ['none', 'max', 'low', 'future'] }
            : { reasoning: { supported_efforts: ['high'] } }),
        },
      ],
    }),
  )
  try {
    const tinfoil = createMockModel({ provider: 'tinfoil', model: 'new-model' })
    const router = createMockModel({ provider: 'openrouter', model: 'new-model' })
    expect(await load(tinfoil)).toEqual({ efforts: ['none', 'low', 'max'] })
    expect(await load(router)).toEqual({ efforts: ['high'] })
    expect(await load(tinfoil)).toEqual({ efforts: ['none', 'low', 'max'] })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith('https://inference.tinfoil.sh/v1/models', { signal: expect.any(AbortSignal) })
  } finally {
    request.mockRestore()
  }
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
