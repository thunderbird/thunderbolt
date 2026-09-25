/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ImageSupportModel } from '@shared/defaults/models'
import { beforeEach, describe, expect, it } from 'bun:test'
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

  it('ignores a corrupted or foreign stored value', () => {
    localStorage.setItem('thunderbolt_image_support', '{not json')
    expect(getCachedImageSupport(model())).toBeUndefined()
    localStorage.setItem('thunderbolt_image_support', JSON.stringify({ anything: 'maybe' }))
    expect(getCachedImageSupport(model())).toBeUndefined()
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
})
