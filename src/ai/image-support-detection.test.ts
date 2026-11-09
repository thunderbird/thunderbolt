/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import {
  saveProviderConnection,
  saveProviderConnectionInTransaction,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { tinfoilSession } from '@/lib/tinfoil-session'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { AvailableModel } from '@/settings/models/model-catalog'
import type { Model } from '@/types'
import {
  defaultModelDeepSeekV41Flash,
  defaultModelId,
  defaultModels,
  defaultModelsVersion,
  type ImageSupport,
} from '@shared/defaults/models'
import { clearImageSupportCache, getCachedImageSupport, setCachedImageSupport } from './image-support'
import { detectImageSupport } from './image-support-detection'
import { ImageSupportInconclusiveError } from './image-support-probe'

const originalConfig = useConfigStore.getState().config
afterEach(() => {
  mock.restore()
  useConfigStore.setState({ config: originalConfig })
})

const proxyFetch: FetchFn = Object.assign(async () => new Response(''), { preconnect: async () => true })
const getProxyFetch = () => proxyFetch

const makeModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: 'model-1',
    name: 'Model',
    provider: 'tinfoil',
    model: 'deepseek-v4-flash',
    url: null,
    apiKey: 'tk-test',
    vendor: null,
    ...overrides,
  }) as Model

const makeOptions = (
  overrides: {
    fetchCatalog?: () => Promise<AvailableModel[]>
    probe?: (model: Model, getProxyFetch: () => FetchFn, signal: AbortSignal) => Promise<ImageSupport>
    signal?: AbortSignal
  } = {},
) => ({
  fetchCatalog: mock(overrides.fetchCatalog ?? (async (): Promise<AvailableModel[]> => [])),
  probe: mock(overrides.probe ?? (async (): Promise<ImageSupport> => 'supported')),
  signal: overrides.signal ?? new AbortController().signal,
})

describe('detectImageSupport', () => {
  beforeEach(() => {
    clearImageSupportCache()
  })

  it('answers from the fixed rules without any request', async () => {
    const options = makeOptions()
    const claude = makeModel({ provider: 'anthropic', model: 'claude-sonnet-5' })
    expect(await detectImageSupport(claude, getProxyFetch, options)).toBe('supported')
    expect(await detectImageSupport(makeModel({ model: 'glm-5-3' }), getProxyFetch, options)).toBe('unsupported')
    expect(options.fetchCatalog).not.toHaveBeenCalled()
    expect(options.probe).not.toHaveBeenCalled()
  })

  it('uses a newer server lineup before starting a catalog request or probe', async () => {
    const serverOnly = { ...defaultModelDeepSeekV41Flash, id: 'server-only-model', model: 'server-vision-model' }
    useConfigStore.setState({
      config: {
        defaults: {
          models: {
            version: defaultModelsVersion + 1,
            defaultModelId,
            data: [...defaultModels, serverOnly],
            imageSupport: { [serverOnly.id]: 'supported' },
          },
        },
      },
    })
    const options = makeOptions()
    expect(await detectImageSupport(makeModel(serverOnly), getProxyFetch, options)).toBe('supported')
    expect(options.fetchCatalog).not.toHaveBeenCalled()
    expect(options.probe).not.toHaveBeenCalled()
  })

  it('answers from this device’s cache without any request', async () => {
    const options = makeOptions()
    setCachedImageSupport(makeModel(), 'unsupported')
    expect(await detectImageSupport(makeModel(), getProxyFetch, options)).toBe('unsupported')
    expect(options.fetchCatalog).not.toHaveBeenCalled()
    expect(options.probe).not.toHaveBeenCalled()
  })

  it('uses the catalog’s answer for providers that publish modalities, and caches it', async () => {
    const options = makeOptions({
      fetchCatalog: async () => [
        { id: 'deepseek-v4-flash', supports_images: true },
        { id: 'gpt-oss-120b', supports_images: false },
      ],
    })

    expect(await detectImageSupport(makeModel(), getProxyFetch, options)).toBe('supported')
    expect(await detectImageSupport(makeModel({ model: 'gpt-oss-120b' }), getProxyFetch, options)).toBe('unsupported')
    expect(options.probe).not.toHaveBeenCalled()
    expect(getCachedImageSupport(makeModel({ model: 'gpt-oss-120b' }))).toBe('unsupported')
  })

  it('passes the model’s credentials to the catalog request', async () => {
    const options = makeOptions()
    await detectImageSupport(
      makeModel({ provider: 'openrouter', model: 'x/y', apiKey: 'or-key' }),
      getProxyFetch,
      options,
    )
    expect(options.fetchCatalog).toHaveBeenCalledWith(
      { provider: 'openrouter', apiKey: 'or-key', url: undefined },
      getProxyFetch,
    )
  })

  it('probes when the catalog doesn’t list the model or says nothing about images', async () => {
    const options = makeOptions({ fetchCatalog: async () => [{ id: 'deepseek-v4-flash' }] })
    expect(await detectImageSupport(makeModel(), getProxyFetch, options)).toBe('supported')
    expect(options.probe).toHaveBeenCalledTimes(1)
  })

  it('probes when the catalog is unreachable', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const options = makeOptions({
      fetchCatalog: async () => {
        throw new TypeError('Failed to fetch with secret-provider-key')
      },
    })
    expect(await detectImageSupport(makeModel(), getProxyFetch, options)).toBe('supported')
    expect(options.probe).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().map(String).join(' ')).not.toContain('secret-provider-key')
    warn.mockRestore()
  })

  it('stops waiting on a stalled catalog at the deadline without starting a probe', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const options = makeOptions({
      fetchCatalog: () => {
        started.resolve()
        return new Promise(() => {})
      },
      probe: async (_model, _getProxyFetch, signal) => {
        throw signal.reason
      },
      signal: controller.signal,
    })

    const detection = detectImageSupport(makeModel(), getProxyFetch, options)
    await started.promise
    controller.abort(new DOMException('The check took too long', 'TimeoutError'))

    await expect(detection).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(options.probe).not.toHaveBeenCalled()
    expect(getCachedImageSupport(makeModel())).toBeUndefined()
    warn.mockRestore()
  })

  it('probes providers without a modality catalog directly, and caches the verdict', async () => {
    const options = makeOptions({ probe: async () => 'unsupported' })
    const ollama = makeModel({ provider: 'custom', model: 'llama3', url: 'http://localhost:11434/v1', apiKey: null })

    expect(await detectImageSupport(ollama, getProxyFetch, options)).toBe('unsupported')
    expect(options.fetchCatalog).not.toHaveBeenCalled()
    expect(options.probe).toHaveBeenCalledWith(ollama, getProxyFetch, options.signal)
    expect(getCachedImageSupport(ollama)).toBe('unsupported')
  })

  it('caches nothing when the probe is inconclusive', async () => {
    const options = makeOptions({
      probe: async () => {
        throw new ImageSupportInconclusiveError('Probe failed with status 401')
      },
    })
    const custom = makeModel({ provider: 'custom', url: 'https://llm.example.com/v1' })

    await expect(detectImageSupport(custom, getProxyFetch, options)).rejects.toBeInstanceOf(
      ImageSupportInconclusiveError,
    )
    expect(getCachedImageSupport(custom)).toBeUndefined()
  })
})

describe('provider-connected image catalogs', () => {
  beforeEach(async () => {
    clearImageSupportCache()
    await resetTestDatabase()
  })
  afterAll(teardownTestDatabase)

  const setup = async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openrouter',
      name: 'OpenRouter',
      authMethod: 'api_key',
      credentials: { apiKey: 'current-key' },
    })
    return makeModel({ provider: 'openrouter', model: 'x/y', providerConnectionId: id, apiKey: 'stale-key' })
  }

  it('resolves the connection credential for a catalog request', async () => {
    const model = await setup()
    const options = makeOptions({ fetchCatalog: async () => [{ id: model.model, supports_images: true }] })
    expect(await detectImageSupport(model, getProxyFetch, options)).toBe('supported')
    expect(options.fetchCatalog).toHaveBeenCalledWith(
      { provider: 'openrouter', apiKey: 'current-key', url: undefined },
      getProxyFetch,
    )
    expect(options.probe).not.toHaveBeenCalled()
  })

  it('does not fetch a catalog or fall back to a probe after disabling the connection', async () => {
    const model = await setup()
    await updateProviderConnection(getDb(), model.providerConnectionId!, { enabled: false })
    const options = makeOptions()
    await expect(detectImageSupport(model, getProxyFetch, options)).rejects.toThrow()
    expect(options.fetchCatalog).not.toHaveBeenCalled()
    expect(options.probe).not.toHaveBeenCalled()
    expect(getCachedImageSupport(model)).toBeUndefined()
  })

  it('uses the current endpoint for both the image check and its cache', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'custom',
      name: 'Vision server',
      url: 'https://current.example/v1',
      authMethod: 'api_key',
      credentials: { apiKey: 'current-key' },
    })
    const model = makeModel({ provider: 'custom', url: 'https://old.example/v1', providerConnectionId: id })
    setCachedImageSupport(model, 'unsupported')
    const options = makeOptions()
    expect(await detectImageSupport(model, getProxyFetch, options)).toBe('supported')
    expect(options.probe).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://current.example/v1', apiKey: 'current-key' }),
      getProxyFetch,
      options.signal,
    )
    expect(getCachedImageSupport({ ...model, url: 'https://current.example/v1' })).toBe('supported')
    expect(getCachedImageSupport(model)).toBe('unsupported')
  })

  it('does not cache a result after the connection is replaced during detection', async () => {
    const model = await setup()
    const options = makeOptions({
      probe: async () => {
        await saveProviderConnection(getDb(), {
          id: model.providerConnectionId!,
          provider: 'openrouter',
          name: 'Replacement account',
          authMethod: 'api_key',
          credentials: { apiKey: 'replacement-key' },
        })
        return 'supported'
      },
    })
    await expect(detectImageSupport(model, getProxyFetch, options)).rejects.toThrow('provider connection changed')
    expect(getCachedImageSupport(model)).toBeUndefined()
  })

  it('keeps the shared deadline while waiting for provider authorization', async () => {
    const id = await getDb().transaction((tx) =>
      saveProviderConnectionInTransaction(tx, {
        provider: 'tinfoil',
        name: 'Tinfoil',
        authMethod: 'oauth',
        credentials: { access_token: 'old', refresh_token: 'refresh' },
      }),
    )
    const started = Promise.withResolvers<void>()
    spyOn(tinfoilSession, 'getAccessToken').mockImplementation(() => {
      started.resolve()
      return new Promise(() => {})
    })
    const controller = new AbortController()
    const options = makeOptions({ signal: controller.signal })
    const model = makeModel({ providerConnectionId: id })
    const detection = detectImageSupport(model, getProxyFetch, options)
    await started.promise
    controller.abort(new DOMException('The check took too long', 'TimeoutError'))
    await expect(detection).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(options.fetchCatalog).not.toHaveBeenCalled()
    expect(options.probe).not.toHaveBeenCalled()
    expect(getCachedImageSupport(model)).toBeUndefined()
  })
})
