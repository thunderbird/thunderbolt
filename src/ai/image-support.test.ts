/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import {
  defaultModelDeepSeekV41Flash,
  defaultModelId,
  defaultModels,
  defaultModelsVersion,
  type ImageSupportModel,
} from '@shared/defaults/models'
import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  clearImageSupportCache,
  getCachedImageSupport,
  getKnownImageSupport,
  setCachedImageSupport,
} from './image-support'

const model = (overrides: Partial<ImageSupportModel> = {}): ImageSupportModel => ({
  provider: 'custom',
  model: 'llava',
  url: 'http://localhost:11434/v1',
  vendor: null,
  ...overrides,
})

describe('image support cache', () => {
  beforeEach(() => {
    clearImageSupportCache()
  })

  it('round-trips a detection result', () => {
    setCachedImageSupport(model(), 'supported')
    expect(getCachedImageSupport(model())).toBe('supported')
  })

  it('keys results by endpoint and model slug', () => {
    setCachedImageSupport(model(), 'unsupported')
    expect(getCachedImageSupport(model({ model: 'llama3' }))).toBeUndefined()
    expect(getCachedImageSupport(model({ url: 'http://localhost:1234/v1' }))).toBeUndefined()
    expect(getCachedImageSupport(model({ provider: 'openai' }))).toBeUndefined()
  })

  it('keeps earlier results when recording a new one', () => {
    setCachedImageSupport(model(), 'supported')
    setCachedImageSupport(model({ model: 'llama3' }), 'unsupported')
    expect(getCachedImageSupport(model())).toBe('supported')
    expect(getCachedImageSupport(model({ model: 'llama3' }))).toBe('unsupported')
  })

  it('forgets everything on clear', () => {
    setCachedImageSupport(model(), 'supported')
    clearImageSupportCache()
    expect(getCachedImageSupport(model())).toBeUndefined()
  })

  it('ignores a corrupted or foreign stored value, and says so', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    localStorage.setItem('thunderbolt_image_support', '{not json')
    expect(getCachedImageSupport(model())).toBeUndefined()
    localStorage.setItem('thunderbolt_image_support', JSON.stringify({ anything: 'maybe' }))
    expect(getCachedImageSupport(model())).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('getKnownImageSupport', () => {
  beforeEach(() => {
    clearImageSupportCache()
  })

  it('prefers the fixed rules over a cached result', () => {
    const claude = model({ provider: 'anthropic', model: 'claude-sonnet-5', url: null })
    setCachedImageSupport(claude, 'unsupported')
    expect(getKnownImageSupport(claude)).toBe('supported')
  })

  it('falls back to the cache, then to unknown', () => {
    expect(getKnownImageSupport(model())).toBeUndefined()
    setCachedImageSupport(model(), 'unsupported')
    expect(getKnownImageSupport(model())).toBe('unsupported')
  })

  describe('with a newer server lineup', () => {
    const serverOnly = { ...defaultModelDeepSeekV41Flash, id: 'server-only-default', model: 'kimi-k3' }

    it('picks the lineup once per payload, so a rejected one warns once', () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      useConfigStore.setState({
        config: {
          defaults: {
            models: {
              version: defaultModelsVersion + 1,
              defaultModelId: serverOnly.id,
              data: [serverOnly],
              imageSupport: { [serverOnly.id]: 'supported' },
            },
          },
        },
      })

      getKnownImageSupport(serverOnly)
      getKnownImageSupport(serverOnly)

      expect(getKnownImageSupport(serverOnly)).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })

    it('answers for a default only the server declares', () => {
      expect(getKnownImageSupport(serverOnly)).toBeUndefined()
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
      expect(getKnownImageSupport(serverOnly)).toBe('supported')
    })
  })
})
