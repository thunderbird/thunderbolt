/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createFutureDirectManagedModelsFixture } from '../../../shared/managed-models.test-fixtures.ts'
import { managedModels } from '../../../shared/managed-models.ts'
import { cliVersion } from '../version.ts'
import type { AccountFetch } from './types.ts'
import { fetchManagedCatalog } from './catalog.ts'

type FetchCall = {
  readonly url: string
  readonly init: RequestInit | undefined
}

type ModelFieldOverrides = {
  readonly id?: string
  readonly model?: string
  readonly name?: string
  readonly description?: string
  readonly vendor?: string
  readonly transport?: string
  readonly capabilities?: CapabilityFixture | null
  readonly defaults?: DefaultsFixture | null
}

type CapabilityFieldOverrides = {
  readonly input?: readonly string[]
  readonly tools?: boolean | number
  readonly parallelToolCalls?: boolean | string
  readonly reasoning?: boolean | null
  readonly contextWindow?: number
}

type DefaultsFieldOverrides = {
  readonly startWithReasoning?: boolean | string
}

type CapabilityFixture = {
  readonly input: readonly string[]
  readonly tools: boolean | number
  readonly parallelToolCalls: boolean | string
  readonly reasoning: boolean | null
  readonly contextWindow: number
}

type DefaultsFixture = {
  readonly startWithReasoning: boolean | string
}

type ModelFixture = {
  readonly id: string
  readonly model: string
  readonly name: string
  readonly description: string
  readonly vendor: string
  readonly transport: string
  readonly capabilities: CapabilityFixture | null
  readonly defaults: DefaultsFixture | null
}

/** Creates an injected JSON transport while retaining the outbound request. */
const createJsonFetch = (body: string, status = 200) => {
  const calls: FetchCall[] = []
  const fetchFn: AccountFetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchFn, calls }
}

const firstModel = managedModels.models[0]!

/** Replaces the first valid catalog model with an arbitrary parser fixture. */
const withFirstModel = (model: ModelFixture | null) => ({
  ...managedModels,
  models: [model, ...managedModels.models.slice(1)],
})

/** Applies known-field overrides to the first valid catalog model. */
const withFirstModelFields = (fields: ModelFieldOverrides) => withFirstModel({ ...firstModel, ...fields })

/** Applies known-field overrides to the first model's capabilities. */
const withFirstCapabilities = (fields: CapabilityFieldOverrides) =>
  withFirstModelFields({ capabilities: { ...firstModel.capabilities, ...fields } })

/** Applies known-field overrides to the first model's defaults. */
const withFirstDefaults = (fields: DefaultsFieldOverrides) =>
  withFirstModelFields({ defaults: { ...firstModel.defaults, ...fields } })

describe('fetchManagedCatalog', () => {
  it('fetches the public config over HTTPS and reconstructs schema v1 in server display order', async () => {
    const reordered = {
      ...managedModels,
      defaultModelId: managedModels.models[1]!.id,
      models: [managedModels.models[1]!, managedModels.models[0]!, ...managedModels.models.slice(2)],
    }
    const { fetchFn, calls } = createJsonFetch(JSON.stringify({ unrelatedConfig: true, managedModels: reordered }))

    const result = await fetchManagedCatalog('https://api.test', fetchFn)

    expect(result).toEqual(reordered)
    expect(result.models.map(({ id }) => id)).toEqual(reordered.models.map(({ id }) => id))
    expect(calls[0]?.url).toBe('https://api.test/v1/config')
    expect(calls[0]?.init?.method).toBe('GET')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('x-app-version')).toBe(cliVersion)
    expect(calls[0]?.init?.redirect).toBe('error')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    ['localhost', 'http://localhost:8000/v1', 'http://localhost:8000/v1/config'],
    ['IPv4 loopback', 'http://127.0.0.1:8000/v1/', 'http://127.0.0.1:8000/v1/config'],
    ['IPv6 loopback', 'http://[::1]:8000/v1', 'http://[::1]:8000/v1/config'],
    ['localhost subdomain', 'http://dev.localhost/v1', 'http://dev.localhost/v1/config'],
    ['trailing query marker', 'https://api.test/v1?', 'https://api.test/v1/config'],
    ['trailing fragment marker', 'https://api.test/v1#', 'https://api.test/v1/config'],
    ['trailing query and fragment markers', 'https://api.test/v1?#', 'https://api.test/v1/config'],
  ] as const)('allows plain HTTP for %s', async (_label, backendUrl, expectedUrl) => {
    const { fetchFn, calls } = createJsonFetch(JSON.stringify({ managedModels }))

    await expect(fetchManagedCatalog(backendUrl, fetchFn)).resolves.toEqual(managedModels)
    expect(calls[0]?.url).toBe(expectedUrl)
  })

  it.each([
    ['remote HTTP', 'http://api.test/v1'],
    ['non-HTTP scheme', 'ftp://localhost/v1'],
    ['malformed URL', 'not-a-url'],
    ['URL credentials', 'https://user:secret@api.test/v1'],
  ] as const)('rejects %s before issuing a request', async (_label, backendUrl) => {
    const { fetchFn, calls } = createJsonFetch(JSON.stringify({ managedModels }))

    const operation = fetchManagedCatalog(backendUrl, fetchFn)

    await expect(operation).rejects.toBeInstanceOf(Error)
    await expect(operation).rejects.toMatchObject({
      code: 'config-invalid',
    })
    expect(calls).toHaveLength(0)
  })

  it('accepts a fixture-only future direct model without model-specific parsing', async () => {
    const futureCatalog = createFutureDirectManagedModelsFixture()
    const { fetchFn } = createJsonFetch(JSON.stringify({ managedModels: futureCatalog }))

    const result = await fetchManagedCatalog('https://api.test/v1', fetchFn)

    expect(result).toEqual(futureCatalog)
  })

  it('drops every unknown additive and private-looking field at every object level', async () => {
    const payload = {
      endpoint: 'https://private-root.test',
      credentials: { bearer: 'root-secret' },
      managedModels: {
        ...managedModels,
        url: 'https://private-catalog.test',
        upstream: 'private-catalog-upstream',
        prices: { input: 123 },
        credentials: { apiKey: 'catalog-secret' },
        models: managedModels.models.map((model) => ({
          ...model,
          provider: 'private-provider',
          upstream: 'private-upstream-model',
          url: 'https://private-model.test',
          price: { input: 1, output: 2 },
          apiKey: 'model-secret',
          capabilities: {
            ...model.capabilities,
            endpoint: 'https://private-capabilities.test',
            credentials: 'capabilities-secret',
          },
          defaults: {
            ...model.defaults,
            upstream: 'private-default',
            price: 42,
          },
        })),
      },
    }
    const { fetchFn } = createJsonFetch(JSON.stringify(payload))

    const result = await fetchManagedCatalog('https://api.test/v1', fetchFn)

    expect(result).toEqual(managedModels)
    expect(Object.keys(result)).toEqual(['schemaVersion', 'version', 'defaultModelId', 'models'])
    expect(Object.keys(result.models[0]!)).toEqual([
      'id',
      'model',
      'name',
      'description',
      'vendor',
      'transport',
      'capabilities',
      'defaults',
    ])
    expect(Object.keys(result.models[0]!.capabilities)).toEqual([
      'input',
      'tools',
      'parallelToolCalls',
      'reasoning',
      'contextWindow',
    ])
    expect(Object.keys(result.models[0]!.defaults)).toEqual(['startWithReasoning'])
  })

  it.each([
    ['zero catalog version', { ...managedModels, version: 0 }],
    ['fractional catalog version', { ...managedModels, version: 1.5 }],
    ['non-UUID default', { ...managedModels, defaultModelId: firstModel.model }],
    ['missing models array', { ...managedModels, models: null }],
    ['non-object model', withFirstModel(null)],
    ['non-canonical model UUID', withFirstModelFields({ id: firstModel.id.toUpperCase() })],
    ['blank model slug', withFirstModelFields({ model: '  ' })],
    ['blank model name', withFirstModelFields({ name: '' })],
    ['blank description', withFirstModelFields({ description: '\t' })],
    ['blank vendor', withFirstModelFields({ vendor: ' ' })],
    ['missing capabilities', withFirstModelFields({ capabilities: null })],
    ['empty input capabilities', withFirstCapabilities({ input: [] })],
    ['duplicate input capabilities', withFirstCapabilities({ input: ['text', 'text'] })],
    ['unknown input capability', withFirstCapabilities({ input: ['text', 'audio'] })],
    ['non-boolean tools', withFirstCapabilities({ tools: 1 })],
    ['non-boolean parallelToolCalls', withFirstCapabilities({ parallelToolCalls: 'yes' })],
    ['non-boolean reasoning', withFirstCapabilities({ reasoning: null })],
    ['zero context window', withFirstCapabilities({ contextWindow: 0 })],
    ['fractional context window', withFirstCapabilities({ contextWindow: 1.5 })],
    ['missing defaults', withFirstModelFields({ defaults: null })],
    ['non-boolean startWithReasoning', withFirstDefaults({ startWithReasoning: 'false' })],
  ] as const)('rejects invalid known field: %s', async (_label, catalog) => {
    const { fetchFn } = createJsonFetch(JSON.stringify({ managedModels: catalog }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })

  it('reports a future schema with the stable upgrade error', async () => {
    const { fetchFn } = createJsonFetch(JSON.stringify({ managedModels: { ...managedModels, schemaVersion: 2 } }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'config-version-unsupported',
    })
  })

  it.each([
    ['a string', '1'],
    ['zero', 0],
    ['a negative integer', -1],
    ['a fraction', 1.5],
  ] as const)('treats schema version %s as invalid rather than as a future schema', async (_label, schemaVersion) => {
    const { fetchFn } = createJsonFetch(JSON.stringify({ managedModels: { ...managedModels, schemaVersion } }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })

  it('rejects duplicate stable model IDs', async () => {
    const duplicate = {
      ...managedModels.models[1]!,
      id: firstModel.id,
      model: 'unique-duplicate-id-fixture',
    }
    const duplicateCatalog = {
      ...managedModels,
      models: [firstModel, duplicate, ...managedModels.models.slice(2)],
    }
    const duplicateFetch = createJsonFetch(JSON.stringify({ managedModels: duplicateCatalog }))

    await expect(fetchManagedCatalog('https://api.test/v1', duplicateFetch.fetchFn)).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })

  it('rejects duplicate public model slugs', async () => {
    const duplicate = { ...managedModels.models[1]!, model: firstModel.model }
    const duplicateCatalog = {
      ...managedModels,
      models: [firstModel, duplicate, ...managedModels.models.slice(2)],
    }
    const { fetchFn } = createJsonFetch(JSON.stringify({ managedModels: duplicateCatalog }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })

  it('rejects selectors that collide between model IDs and public slugs', async () => {
    const secondModel = managedModels.models[1]!
    const collidingCatalog = {
      ...managedModels,
      models: [
        { ...firstModel, model: secondModel.id },
        { ...secondModel, model: firstModel.id },
        ...managedModels.models.slice(2),
      ],
    }
    const { fetchFn } = createJsonFetch(JSON.stringify({ managedModels: collidingCatalog }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })

  it('rejects a default model ID that is absent from the ordered models', async () => {
    const { fetchFn } = createJsonFetch(
      JSON.stringify({
        managedModels: { ...managedModels, defaultModelId: '019f0000-0000-7000-8000-000000000099' },
      }),
    )

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })

  it('rejects an unknown transport with the stable transport error', async () => {
    const { fetchFn } = createJsonFetch(
      JSON.stringify({ managedModels: withFirstModelFields({ transport: 'telepathy' }) }),
    )

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'transport-unsupported',
    })
  })

  it('normalizes thrown fetch failures to a stable network error without exposing the cause', async () => {
    const fetchFn: AccountFetch = async () => {
      throw new Error('socket failed with secret-token')
    }

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'network',
    })
  })

  it('aborts a stalled catalog response and reports the stable network error', async () => {
    const request = { signal: null as AbortSignal | null }
    const fetchFn: AccountFetch = async (_input, init) => {
      request.signal = init?.signal ?? null
      return await new Promise<Response>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason))
      })
    }
    const pendingCatalog = fetchManagedCatalog('https://api.test/v1', fetchFn, 1)

    await expect(pendingCatalog).rejects.toMatchObject({
      code: 'network',
    })
    expect(request.signal?.aborted).toBeTrue()
  })

  it('normalizes response body read failures to a network error', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.error(new Error('stream failed with private detail')),
    })
    const fetchFn: AccountFetch = async () => new Response(body)

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'network',
    })
  })

  it('normalizes non-success HTTP responses to a stable network error', async () => {
    const { fetchFn } = createJsonFetch(JSON.stringify({ error: 'private backend detail' }), 503)

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'network',
    })
  })

  it('cancels a non-success response body without waiting for cancellation', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true
        return new Promise<void>(() => {})
      },
    })
    const fetchFn: AccountFetch = async () => new Response(body, { status: 503 })

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'network',
    })
    expect(cancelled).toBeTrue()
  })

  it('rejects malformed JSON with a stable config error', async () => {
    const fetchFn: AccountFetch = async () => new Response('{', { status: 200 })

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })

  it('rejects a response without a managed catalog', async () => {
    const { fetchFn } = createJsonFetch(JSON.stringify({ builtInAgentEnabled: true }))

    await expect(fetchManagedCatalog('https://api.test/v1', fetchFn)).rejects.toMatchObject({
      code: 'config-invalid',
    })
  })
})
