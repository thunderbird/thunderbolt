/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Run-spec resolution. The one thing that must never happen is sending the local
 * row id: the runner passes `modelId` to the backend inference gateway, which
 * knows `Model.model` and nothing about this device's rows.
 */

import type { Model, ModelProfile } from '@/types'
import { describe, expect, it, mock } from 'bun:test'
import { resolveRunSpec, type RunSpecDeps } from './runner-run-spec'

const model = {
  id: 'local-row-id',
  model: 'thunderbolt/opus-mini',
  provider: 'thunderbolt',
} as Model

const deps = (profile: ModelProfile | null): RunSpecDeps => ({
  getDb: (() => ({})) as RunSpecDeps['getDb'],
  getModelProfile: (async () => profile) as RunSpecDeps['getModelProfile'],
})

describe('resolveRunSpec', () => {
  it('sends the gateway model id, never the local row id', async () => {
    const spec = await resolveRunSpec(model, deps(null))

    expect(spec.modelId).toBe('thunderbolt/opus-mini')
    expect(spec.modelId).not.toBe(model.id)
  })

  it('derives the thinking level from the model’s profile', async () => {
    const profile = { providerOptions: { reasoningEffort: 'xhigh' } } as unknown as ModelProfile

    expect(await resolveRunSpec(model, deps(profile))).toEqual({
      modelId: 'thunderbolt/opus-mini',
      thinkingLevel: 'xhigh',
    })
  })

  it('falls back to the adaptive level for a model with no profile', async () => {
    expect((await resolveRunSpec(model, deps(null))).thinkingLevel).toBe('medium')
  })

  it('looks the profile up by the model’s local row id', async () => {
    const getModelProfile = mock(async (_db: unknown, _modelId: string) => null)

    await resolveRunSpec(model, {
      getDb: (() => ({})) as RunSpecDeps['getDb'],
      getModelProfile: getModelProfile as RunSpecDeps['getModelProfile'],
    })

    expect(getModelProfile.mock.calls[0]?.[1]).toBe('local-row-id')
  })
})
