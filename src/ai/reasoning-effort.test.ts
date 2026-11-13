/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, expect, it, mock, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { http } from '@/lib/http'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import {
  createReasoningCapabilitiesLoader,
  getChatReasoningEffort,
  loadReasoningCapabilities,
  queueReasoningEffortWrite,
} from './reasoning-effort'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { updateSettings } from '@/dal/settings'
import { createModel, updateModel } from '@/dal/models'
import { upsertModelProfile, deleteModelProfileForModel, getModelProfile } from '@/dal/model-profiles'
import { defaultModelDeepSeekV41Flash, defaultModelGlm53 } from '@shared/defaults/models'
import { eq } from 'drizzle-orm'
import { getCurrentDatabase, getDb, setDatabase } from '@/db/database'
import { modelsTable } from '@/db/tables'
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

it('offers only Privatemode model-supported reasoning levels without importing a transport', async () => {
  const load = createReasoningCapabilitiesLoader()
  expect(await load(createMockModel({ provider: 'privatemode', model: 'glm-5.3' }))).toEqual({
    efforts: ['none', 'low', 'high', 'max'],
  })
  expect(await load(createMockModel({ provider: 'privatemode', model: 'gpt-oss-120b' }))).toEqual({
    efforts: ['low', 'medium', 'high'],
  })
  expect(await load(createMockModel({ provider: 'privatemode', model: 'future-model' }))).toEqual({ efforts: [] })
})

it('serializes repeated model writes and waits for the latest preference from any chat', async () => {
  const db = getDb()
  const model = createMockModel({ id: 'queued-effort' })
  await createModel(getDb(), model)
  const other = createMockModel({ id: 'independent-effort' })
  const capabilities = async () => ({ efforts: ['low', 'medium', 'high'] as const })
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const saveFirst = mock(async () => {
    await first.promise
    await updateModel(db, model.id, { reasoningEffort: 'high' })
  })
  const saveSecond = mock(async () => {
    await second.promise
    await updateModel(db, model.id, { reasoningEffort: 'low' })
  })
  const firstWrite = queueReasoningEffortWrite(getDb(), model.id, saveFirst)
  const secondWrite = queueReasoningEffortWrite(getDb(), model.id, saveSecond)
  const readEffort = getChatReasoningEffort('other-chat', model, capabilities)
  const completed = { value: false }
  void readEffort.then(() => {
    completed.value = true
  })
  try {
    expect(await getChatReasoningEffort('another-chat', other, capabilities)).toBe('medium')
    expect(saveFirst).toHaveBeenCalledTimes(1)
    expect(saveSecond).not.toHaveBeenCalled()
    expect(completed.value).toBe(false)
    first.resolve()
    await firstWrite
    await Promise.resolve()
    expect(saveSecond).toHaveBeenCalledTimes(1)
    expect(completed.value).toBe(false)
    second.resolve()
    await secondWrite
    expect(await readEffort).toBe('low')
    expect(await getChatReasoningEffort('first-chat', model, capabilities)).toBe('low')
  } finally {
    first.resolve()
    second.resolve()
    await Promise.allSettled([firstWrite, secondWrite, readEffort])
  }
})

it('serializes SQLite transactions even when the user switches models before a save finishes', async () => {
  const db = getDb()
  const first = createMockModel({ id: 'transaction-first' })
  const second = createMockModel({ id: 'transaction-second' })
  await createModel(db, first)
  await createModel(db, second)
  const capabilities = async () => ({ efforts: ['low', 'high'] as const })
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const firstWrite = queueReasoningEffortWrite(db, first.id, () =>
    db.transaction(async (tx) => {
      started.resolve()
      await finish.promise
      await tx.update(modelsTable).set({ reasoningEffort: 'high' }).where(eq(modelsTable.id, first.id))
    }),
  )
  await started.promise
  const saveSecond = mock(() => updateModel(db, second.id, { reasoningEffort: 'low' }))
  const secondWrite = queueReasoningEffortWrite(db, second.id, saveSecond)
  const secondRead = getChatReasoningEffort('switched-chat', second, capabilities)
  try {
    await Promise.resolve()
    await Promise.resolve()
    expect(saveSecond).not.toHaveBeenCalled()
    finish.resolve()
    await Promise.all([firstWrite, secondWrite])
    expect(await secondRead).toBe('low')
    expect(await getChatReasoningEffort('first-chat', first, capabilities)).toBe('high')
  } finally {
    finish.resolve()
    await Promise.allSettled([firstWrite, secondWrite, secondRead])
  }
})

it('rejects a send waiting on a failed preference write without poisoning the next choice', async () => {
  const model = createMockModel({ id: 'failed-effort' })
  await createModel(getDb(), model)
  const capabilities = async () => ({ efforts: ['low', 'high'] as const })
  const first = Promise.withResolvers<void>()
  const write = queueReasoningEffortWrite(getDb(), model.id, () => first.promise)
  const read = getChatReasoningEffort('waiting-chat', model, capabilities)
  const failed = Promise.allSettled([write, read])
  const next = queueReasoningEffortWrite(getDb(), model.id, () =>
    updateModel(getDb(), model.id, { reasoningEffort: 'low' }),
  )
  const error = new Error('Settings write failed')
  first.reject(error)
  expect(await failed).toEqual([
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ])
  await next
  expect(await getChatReasoningEffort('retry-chat', model, capabilities)).toBe('low')
})

it('isolates queued preferences when the account database changes', async () => {
  const original = getCurrentDatabase()!
  const model = createMockModel({ id: 'account-effort' })
  await createModel(getDb(), model)
  const capabilities = async () => ({ efforts: ['low', 'medium', 'high'] as const })
  const save = Promise.withResolvers<void>()
  const write = queueReasoningEffortWrite(getDb(), model.id, async () => {
    await save.promise
    await updateModel(original.db, model.id, { reasoningEffort: 'high' })
  })
  const originalRead = getChatReasoningEffort('old-account-chat', model, capabilities)
  await setupTestDatabase()
  const other = getCurrentDatabase()!
  await createModel(other.db, model)
  try {
    expect(await getChatReasoningEffort('new-account-chat', model, capabilities)).toBe('medium')
    await queueReasoningEffortWrite(getDb(), model.id, () =>
      updateModel(other.db, model.id, { reasoningEffort: 'low' }),
    )
    save.resolve()
    await write
    expect(await originalRead).toBe('high')
    expect(await getChatReasoningEffort('new-account-chat', model, capabilities)).toBe('low')
  } finally {
    save.resolve()
    await Promise.allSettled([write, originalRead])
    setDatabase(original)
    await other.close()
  }
})

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

it('shares model choices across chats, preserves legacy choices, and defaults to a supported effort', async () => {
  const model = createMockModel({ id: 'saved-effort', provider: 'tinfoil', model: 'glm-5-3' })
  await createModel(getDb(), model)
  const key = reasoningEffortSettingKey('saved-chat', model.id)
  const request = spyOn(http, 'get').mockImplementation(() =>
    response({
      data: [{ id: 'glm-5-3', reasoning: true, supported_efforts: ['low', 'high', 'max'] }],
    }),
  )
  try {
    expect(await getChatReasoningEffort('saved-chat', model)).toBe('high')
    await updateSettings(getDb(), { [key]: 'invalid' })
    expect(await getChatReasoningEffort('saved-chat', model)).toBe('high')
    await updateSettings(getDb(), { [key]: 'none' })
    expect(await getChatReasoningEffort('saved-chat', model)).toBe('high')
    await updateSettings(getDb(), { [key]: 'max' })
    expect(await getChatReasoningEffort('saved-chat', model)).toBe('max')
    expect(await getChatReasoningEffort('other-chat', model)).toBe('high')
    await updateModel(getDb(), model.id, { reasoningEffort: 'low' })
    expect(await getChatReasoningEffort('saved-chat', model)).toBe('low')
    expect(await getChatReasoningEffort('other-chat', model)).toBe('low')
    await updateModel(getDb(), model.id, { reasoningEffort: 'invalid' })
    expect(await getChatReasoningEffort('saved-chat', model)).toBe('high')
    await updateModel(getDb(), model.id, { reasoningEffort: null })
    expect(await getChatReasoningEffort('saved-chat', model)).toBe('max')
    expect(await getChatReasoningEffort('saved-chat', { ...model, id: 'other-model' })).toBe('high')
    expect(await getChatReasoningEffort('saved-chat', { ...model, model: 'llama3-3-70b' })).toBeUndefined()
  } finally {
    request.mockRestore()
  }
})

it.each([
  { model: defaultModelDeepSeekV41Flash, effort: 'low' },
  { model: defaultModelGlm53, effort: 'max' },
] as const)('preserves the bundled tuned profile for $model.name', async ({ model: defaultModel, effort }) => {
  const model = { ...defaultModel, apiKey: null, reasoningEffort: null }
  await updateModel(getDb(), model.id, { reasoningEffort: null })
  const capabilities = async () => ({ efforts: ['none', 'low', 'medium', 'high', 'max'] as const })
  expect((await getModelProfile(getDb(), model.id))?.providerOptions?.reasoningEffort).toBe(effort)
  expect(await getChatReasoningEffort('profile-chat', model, capabilities)).toBeUndefined()
  await updateSettings(getDb(), { [reasoningEffortSettingKey('profile-chat', model.id)]: 'high' })
  expect(await getChatReasoningEffort('profile-chat', model, capabilities)).toBe('high')
  await updateModel(getDb(), model.id, { reasoningEffort: 'none' })
  expect(await getChatReasoningEffort('profile-chat', model, capabilities)).toBe('none')
  expect(await getChatReasoningEffort('other-profile-chat', model, capabilities)).toBe('none')
})

it('preserves live profile options, including configured levels outside the current catalog, and excludes deleted profiles', async () => {
  const model = createMockModel({ id: 'profile-effort' })
  await createModel(getDb(), model)
  const capabilities = async () => ({ efforts: ['none', 'low', 'medium', 'high'] as const })
  const read = () => getChatReasoningEffort('profile-chat', model, capabilities)
  expect(await read()).toBe('medium')
  await upsertModelProfile(getDb(), { modelId: model.id, providerOptions: { reasoning: { effort: 'low' } } })
  expect(await read()).toBeUndefined()
  await upsertModelProfile(getDb(), { modelId: model.id, providerOptions: { reasoningEffort: 'max' } })
  expect(await read()).toBeUndefined()
  await upsertModelProfile(getDb(), { modelId: model.id, providerOptions: { effort: 'high' } })
  expect(await read()).toBeUndefined()
  await deleteModelProfileForModel(getDb(), model.id)
  expect(await read()).toBe('medium')
})

it.each([{ enabled: false }, { enabled: true }, { max_tokens: 1024 }, { max_tokens: 16384 }])(
  'preserves native OpenRouter profile %j without an explicit saved effort',
  async (reasoning) => {
    const model = createMockModel({ id: `router-profile-${JSON.stringify(reasoning)}`, provider: 'openrouter' })
    await createModel(getDb(), model)
    await upsertModelProfile(getDb(), { modelId: model.id, providerOptions: { reasoning } })
    const capabilities = async () => ({ efforts: ['low', 'high'] as const })
    expect(await getChatReasoningEffort('profile-chat', model, capabilities)).toBeUndefined()
    await updateModel(getDb(), model.id, { reasoningEffort: 'high' })
    expect(await getChatReasoningEffort('profile-chat', model, capabilities)).toBe('high')
  },
)

it('defaults optional thinking off and respects a configured profile or explicit toggle choice', async () => {
  const model = createMockModel({ id: 'toggle-default', provider: 'anthropic', model: 'claude-sonnet-4-5' })
  await createModel(getDb(), model)
  const read = () => getChatReasoningEffort('toggle-chat', model)
  expect(await read()).toBe('none')
  await upsertModelProfile(getDb(), { modelId: model.id, providerOptions: { thinking: { budgetTokens: 4096 } } })
  expect(await read()).toBeUndefined()
  await updateModel(getDb(), model.id, { reasoningEffort: 'none' })
  expect(await read()).toBe('none')
})

it('surfaces local capability lookup errors instead of silently changing effort', async () => {
  const model = createMockModel({ id: 'broken-local-catalog', provider: 'openai' })
  const load = async () => {
    throw new Error('Local catalog import failed')
  }
  await expect(getChatReasoningEffort('local-chat', model, load)).rejects.toThrow('Local catalog import failed')
})

it.each(['openrouter', 'tinfoil'])(
  'keeps a saved %s choice when discovery fails before any catalog has loaded',
  async (provider) => {
    const model = createMockModel({ id: `${provider}-outage`, provider, model: 'test/outage' })
    await createModel(getDb(), model)
    const lookup = createReasoningCapabilitiesLoader()
    const readEffort = (threadId: string) => getChatReasoningEffort(threadId, model, lookup)
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
      expect(await readEffort('router-outage-chat')).toBeUndefined()
      await updateSettings(getDb(), { [reasoningEffortSettingKey('router-outage-chat', model.id)]: 'low' })
      expect(await readEffort('router-outage-chat')).toBe('low')
      await updateModel(getDb(), model.id, { reasoningEffort: 'high' })
      expect(await readEffort('router-outage-chat')).toBe('high')
      await updateModel(getDb(), model.id, { reasoningEffort: 'none' })
      expect(await readEffort('router-outage-chat')).toBe('none')
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(warn).toHaveBeenCalledTimes(4)
      await updateModel(getDb(), model.id, { reasoningEffort: 'invalid' })
      expect(await readEffort('router-outage-chat')).toBeUndefined()
      expect(await readEffort('unsaved-chat')).toBeUndefined()
      expect(fetch).toHaveBeenCalledTimes(6)
      expect(warn).toHaveBeenCalledTimes(6)
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
