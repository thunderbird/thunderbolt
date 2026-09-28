/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { AvailableModel } from '@/settings/models/model-catalog'
import type { Model } from '@/types'
import type { ImageSupport } from '@shared/defaults/models'
import { clearImageSupportCache, getCachedImageSupport, setCachedImageSupport } from './image-support'
import { detectImageSupport } from './image-support-detection'
import { ImageSupportInconclusiveError } from './image-support-probe'

const getProxyFetch = () => (async () => new Response('')) as unknown as FetchFn

const makeModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: 'model-1',
    name: 'Model',
    provider: 'tinfoil',
    model: 'deepseek-v4-1-flash',
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
        { id: 'deepseek-v4-1-flash', supports_images: true },
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
    expect(options.fetchCatalog).toHaveBeenCalledWith({ provider: 'openrouter', apiKey: 'or-key', url: undefined })
  })

  it('probes when the catalog doesn’t list the model or says nothing about images', async () => {
    const options = makeOptions({ fetchCatalog: async () => [{ id: 'deepseek-v4-1-flash' }] })
    expect(await detectImageSupport(makeModel(), getProxyFetch, options)).toBe('supported')
    expect(options.probe).toHaveBeenCalledTimes(1)
  })

  it('probes when the catalog is unreachable', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const options = makeOptions({
      fetchCatalog: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(await detectImageSupport(makeModel(), getProxyFetch, options)).toBe('supported')
    expect(options.probe).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('stops waiting on a stalled catalog at the deadline, which the probe shares', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new AbortController()
    const options = makeOptions({
      fetchCatalog: () => new Promise(() => {}),
      probe: async (_model, _getProxyFetch, signal) => {
        throw signal.reason
      },
      signal: controller.signal,
    })

    const detection = detectImageSupport(makeModel(), getProxyFetch, options)
    controller.abort(new DOMException('The check took too long', 'TimeoutError'))

    await expect(detection).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(options.probe).toHaveBeenCalledWith(makeModel(), getProxyFetch, controller.signal)
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
