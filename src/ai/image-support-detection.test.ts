/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import { clearImageSupportCache, getCachedImageSupport, setCachedImageSupport } from './image-support'
import { detectImageSupport, type ImageSupportDetectionDeps } from './image-support-detection'
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

const makeDeps = (overrides: Partial<ImageSupportDetectionDeps> = {}) => {
  const deps = {
    fetchCatalog: mock(async () => [] as Awaited<ReturnType<ImageSupportDetectionDeps['fetchCatalog']>>),
    probe: mock(async () => 'supported' as const),
    ...overrides,
  }
  return deps as typeof deps & ImageSupportDetectionDeps
}

describe('detectImageSupport', () => {
  beforeEach(() => {
    clearImageSupportCache()
  })

  it('answers from the fixed rules without any request', async () => {
    const deps = makeDeps()
    const claude = makeModel({ provider: 'anthropic', model: 'claude-sonnet-5' })
    expect(await detectImageSupport(claude, getProxyFetch, deps)).toBe('supported')
    expect(await detectImageSupport(makeModel({ model: 'glm-5-3' }), getProxyFetch, deps)).toBe('unsupported')
    expect(deps.fetchCatalog).not.toHaveBeenCalled()
    expect(deps.probe).not.toHaveBeenCalled()
  })

  it('answers from this device’s cache without any request', async () => {
    const deps = makeDeps()
    setCachedImageSupport(makeModel(), 'unsupported')
    expect(await detectImageSupport(makeModel(), getProxyFetch, deps)).toBe('unsupported')
    expect(deps.fetchCatalog).not.toHaveBeenCalled()
    expect(deps.probe).not.toHaveBeenCalled()
  })

  it('uses the catalog’s answer for providers that publish modalities, and caches it', async () => {
    const deps = makeDeps({
      fetchCatalog: mock(async () => [
        { id: 'deepseek-v4-1-flash', supports_images: true },
        { id: 'gpt-oss-120b', supports_images: false },
      ]),
    })

    expect(await detectImageSupport(makeModel(), getProxyFetch, deps)).toBe('supported')
    expect(await detectImageSupport(makeModel({ model: 'gpt-oss-120b' }), getProxyFetch, deps)).toBe('unsupported')
    expect(deps.probe).not.toHaveBeenCalled()
    expect(getCachedImageSupport(makeModel({ model: 'gpt-oss-120b' }))).toBe('unsupported')
  })

  it('passes the model’s credentials to the catalog request', async () => {
    const deps = makeDeps()
    await detectImageSupport(makeModel({ provider: 'openrouter', model: 'x/y', apiKey: 'or-key' }), getProxyFetch, deps)
    expect(deps.fetchCatalog).toHaveBeenCalledWith({ provider: 'openrouter', apiKey: 'or-key', url: undefined })
  })

  it('probes when the catalog doesn’t list the model or says nothing about images', async () => {
    const deps = makeDeps({ fetchCatalog: mock(async () => [{ id: 'deepseek-v4-1-flash' }]) })
    expect(await detectImageSupport(makeModel(), getProxyFetch, deps)).toBe('supported')
    expect(deps.probe).toHaveBeenCalledTimes(1)
  })

  it('probes when the catalog is unreachable', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const deps = makeDeps({
      fetchCatalog: mock(async () => {
        throw new TypeError('Failed to fetch')
      }),
    })
    expect(await detectImageSupport(makeModel(), getProxyFetch, deps)).toBe('supported')
    expect(deps.probe).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('probes providers without a modality catalog directly, and caches the verdict', async () => {
    const deps = makeDeps({ probe: mock(async () => 'unsupported' as const) })
    const ollama = makeModel({ provider: 'custom', model: 'llama3', url: 'http://localhost:11434/v1', apiKey: null })

    expect(await detectImageSupport(ollama, getProxyFetch, deps)).toBe('unsupported')
    expect(deps.fetchCatalog).not.toHaveBeenCalled()
    expect(deps.probe).toHaveBeenCalledWith(ollama, getProxyFetch)
    expect(getCachedImageSupport(ollama)).toBe('unsupported')
  })

  it('caches nothing when the probe is inconclusive', async () => {
    const deps = makeDeps({
      probe: mock(async () => {
        throw new ImageSupportInconclusiveError('Probe failed with status 401')
      }),
    })
    const custom = makeModel({ provider: 'custom', url: 'https://llm.example.com/v1' })

    await expect(detectImageSupport(custom, getProxyFetch, deps)).rejects.toBeInstanceOf(ImageSupportInconclusiveError)
    expect(getCachedImageSupport(custom)).toBeUndefined()
  })
})
