/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { clearGatewayModelCache, ensureGatewayModels } from '@/inference/gateway-models'
import { createTestSettings } from '@/test-utils/settings'
import { defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { createConfigRoutes } from './config'

const fetchConfig = async (settings: Parameters<typeof createConfigRoutes>[0]) => {
  const app = new Elysia().use(createConfigRoutes(settings))
  const response = await app.handle(new Request('http://localhost/config'))
  return { status: response.status, body: await response.json() }
}

describe('Config Routes', () => {
  beforeEach(() => {
    clearGatewayModelCache()
  })

  describe('GET /config', () => {
    it('reflects e2eeEnabled', async () => {
      const disabled = await fetchConfig(createTestSettings({ e2eeEnabled: false }))
      expect(disabled.body.e2eeEnabled).toBe(false)

      const enabled = await fetchConfig(createTestSettings({ e2eeEnabled: true }))
      expect(enabled.body.e2eeEnabled).toBe(true)
    })

    it('exposes builtInAgentEnabled: true by default and false when disabled', async () => {
      const onByDefault = await fetchConfig(createTestSettings())
      expect(onByDefault.body.builtInAgentEnabled).toBe(true)

      const disabled = await fetchConfig(createTestSettings({ disableBuiltInAgent: true }))
      expect(disabled.body.builtInAgentEnabled).toBe(false)
    })

    it('exposes allowCustomAgents', async () => {
      const allowed = await fetchConfig(createTestSettings({ allowCustomAgents: true }))
      expect(allowed.body.allowCustomAgents).toBe(true)

      const forbidden = await fetchConfig(createTestSettings({ allowCustomAgents: false }))
      expect(forbidden.body.allowCustomAgents).toBe(false)
    })

    it('omits minAppVersion when MIN_APP_VERSION is unset', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body.minAppVersion).toBeUndefined()
    })

    it('exposes minAppVersion when set', async () => {
      const { body } = await fetchConfig(createTestSettings({ minAppVersion: '0.2.0' }))
      expect(body.minAppVersion).toBe('0.2.0')
    })

    it('does not require authentication', async () => {
      const { status } = await fetchConfig(createTestSettings())
      expect(status).toBe(200)
    })

    it('ships models defaults with their shared version', async () => {
      const { body } = await fetchConfig(createTestSettings())
      expect(body.defaults.models.version).toBe(defaultModelsVersion)
      expect(body.defaults.models.data).toEqual(defaultModels)
    })

    it('leaves models defaults untouched when no inference gateway is configured', async () => {
      const { body } = await fetchConfig(createTestSettings({ thunderboltInferenceModels: 'ignored' }))
      expect(body.defaults.models.version).toBe(defaultModelsVersion)
      expect(body.defaults.models.data).toEqual(defaultModels)
    })

    it('appends inference gateway models and out-versions the bundled defaults', async () => {
      const settings = createTestSettings({
        thunderboltInferenceUrl: 'https://gateway.example.com/v1',
        thunderboltInferenceApiKey: 'key',
        thunderboltInferenceModels: 'llama-3.3-70b=Llama 3.3 70B',
      })
      // Models are discovered from the gateway, so prime the cache with a stubbed
      // /models response; the route then reads it without any network access.
      await ensureGatewayModels(settings, {
        fetchFn: mock(
          async () => new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }] }), { status: 200 }),
        ) as never,
      })
      const { body } = await fetchConfig(settings)

      // A higher version is what makes the client prefer this payload over its
      // bundled copy, and keeping the shipped defaults preserves the id overlap
      // `pickDefaults` requires before it trusts the server.
      expect(body.defaults.models.version).toBe(defaultModelsVersion + 1)
      expect(body.defaults.models.data).toHaveLength(defaultModels.length + 1)
      expect(body.defaults.models.data.slice(0, defaultModels.length)).toEqual(defaultModels)

      const gatewayModel = body.defaults.models.data.at(-1)
      expect(gatewayModel.name).toBe('Llama 3.3 70B')
      expect(gatewayModel.model).toBe('llama-3.3-70b')
      expect(gatewayModel.provider).toBe('thunderbolt')
      expect(gatewayModel.url).toBeNull()
    })
  })
})
