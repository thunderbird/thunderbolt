/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { defaultModelId, defaultModels } from '@shared/defaults/models'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { ConnectionTestProbe } from '@/hooks/use-model-connection-test'
import { prepareProviderDefaultModel, resolveProviderDefaultModel } from './provider-default-model'

const preferred = defaultModels.find((model) => model.id === defaultModelId)!
const getFetch = (): FetchFn =>
  Object.assign(
    async () => {
      throw new Error('Unexpected network')
    },
    { preconnect: async () => false },
  )

describe('provider default model', () => {
  it('uses the provider catalog spelling for the shipped agent default', () => {
    const candidate = { id: `${preferred.vendor}/${preferred.model.replace('4-1', '4.1')}`, supports_tools: true }
    expect(resolveProviderDefaultModel([{ id: 'unrelated-model' }, candidate])).toBe(candidate)
    expect(resolveProviderDefaultModel([{ id: preferred.model }])?.id).toBe(preferred.model)
  })

  it('rejects different variants, disabled tool support, and ambiguous matches', () => {
    expect(resolveProviderDefaultModel([{ id: preferred.model + ':free' }])).toBeUndefined()
    expect(resolveProviderDefaultModel([{ id: preferred.model, supports_tools: false }])).toBeUndefined()
    expect(
      resolveProviderDefaultModel([{ id: `a/${preferred.model}` }, { id: `b/${preferred.model}` }]),
    ).toBeUndefined()
  })

  it('checks the selected model with the credential and preserves its metadata', async () => {
    const probe = mock<ConnectionTestProbe>(async () => 'supported')
    const values = await prepareProviderDefaultModel('tinfoil', 'secret', getFetch, new AbortController().signal, {
      fetchModels: async () => [{ id: preferred.model }],
      probe,
    })
    expect(values.providerDefault).toBe(1)
    expect(values.model).toBe(preferred.model)
    expect(values.contextWindow).toBe(preferred.contextWindow)
    expect(values.isConfidential).toBe(1)
    expect(probe.mock.calls[0][0]).toEqual({ provider: 'tinfoil', model: preferred.model, apiKey: 'secret', url: null })
  })

  it('fails if the default is unavailable, instead of picking a different model', async () => {
    const probe = mock<ConnectionTestProbe>(async () => 'supported')
    await expect(
      prepareProviderDefaultModel('openrouter', 'key', getFetch, new AbortController().signal, {
        fetchModels: async () => [{ id: 'unrelated-model' }],
        probe,
      }),
    ).rejects.toThrow('unavailable')
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not return credentials for persistence when the connection probe fails', async () => {
    await expect(
      prepareProviderDefaultModel('tinfoil', 'key', getFetch, new AbortController().signal, {
        fetchModels: async () => [{ id: preferred.model }],
        probe: async () => {
          throw new Error('Invalid key')
        },
      }),
    ).rejects.toMatchObject({ stage: 'probe', cause: { message: 'Invalid key' } })
  })

  it('cancels a hung catalog and never probes its late result', async () => {
    const catalog = Promise.withResolvers<Array<{ id: string }>>()
    const controller = new AbortController()
    const probe = mock<ConnectionTestProbe>(async () => 'supported')
    const pending = prepareProviderDefaultModel('openrouter', 'key', getFetch, controller.signal, {
      fetchModels: () => catalog.promise,
      probe,
    })
    controller.abort(new Error('Cancelled'))
    await expect(pending).rejects.toThrow('Cancelled')
    catalog.resolve([{ id: preferred.model }])
    await Promise.resolve()
    expect(probe).not.toHaveBeenCalled()
  })
})
