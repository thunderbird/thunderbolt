/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import type { Model } from '@/types'
import { mapModelToDeployConnection } from './build-deploy-model-connection'

const model = (overrides: Partial<Model>): Model =>
  ({ provider: 'thunderbolt', model: 'gpt-4o', url: null, apiKey: null, ...overrides }) as Model

describe('mapModelToDeployConnection', () => {
  it('maps a managed thunderbolt model without an apiKey (backend mints + overrides baseUrl)', () => {
    expect(mapModelToDeployConnection(model({ provider: 'thunderbolt', model: 'claude-managed' }))).toEqual({
      provider: 'thunderbolt',
      model: 'claude-managed',
      baseUrl: '',
      compatibility: 'openai',
    })
  })

  it('maps a fixed BYOK provider with the user key and provider base URL', () => {
    expect(
      mapModelToDeployConnection(model({ provider: 'anthropic', model: 'claude-sonnet', apiKey: 'sk-ant' })),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet',
      baseUrl: 'https://api.anthropic.com',
      compatibility: 'anthropic',
      apiKey: 'sk-ant',
    })
  })

  it('uses openai compatibility for openrouter BYOK', () => {
    expect(mapModelToDeployConnection(model({ provider: 'openrouter', model: 'x', apiKey: 'k' }))).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      compatibility: 'openai',
    })
  })

  it('derives the base URL from the model url for a custom model and normalizes /v1', () => {
    expect(
      mapModelToDeployConnection(
        model({ provider: 'custom', model: 'local-x', url: 'https://api.example.com', apiKey: 'k' }),
      ),
    ).toEqual({
      provider: 'custom',
      model: 'local-x',
      baseUrl: 'https://api.example.com/v1',
      compatibility: 'openai',
      apiKey: 'k',
    })
  })

  it('returns undefined for an excluded provider (tinfoil)', () => {
    expect(mapModelToDeployConnection(model({ provider: 'tinfoil', model: 'glm' }))).toBeUndefined()
  })

  it('returns undefined for a custom model with no url', () => {
    expect(mapModelToDeployConnection(model({ provider: 'custom', model: 'x', url: null }))).toBeUndefined()
  })
})
