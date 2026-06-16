/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createTestSettings } from '@/test-utils/settings'
import { createConfigRoutes } from './config'

const fetchConfig = async (settings: Parameters<typeof createConfigRoutes>[0]) => {
  const app = new Elysia().use(createConfigRoutes(settings))
  const response = await app.handle(new Request('http://localhost/config'))
  return { status: response.status, body: await response.json() }
}

describe('Config Routes', () => {
  describe('GET /config', () => {
    it('returns the configured serverId', async () => {
      const serverId = '11111111-2222-3333-4444-555555555555'
      const { body } = await fetchConfig(createTestSettings({ serverId }))
      expect(body.serverId).toBe(serverId)
    })

    it('reflects e2eeEnabled', async () => {
      const disabled = await fetchConfig(createTestSettings({ e2eeEnabled: false }))
      expect(disabled.body.e2eeEnabled).toBe(false)

      const enabled = await fetchConfig(createTestSettings({ e2eeEnabled: true }))
      expect(enabled.body.e2eeEnabled).toBe(true)
    })

    it('exposes allowAnonUsers from the authAllowAnonymous setting', async () => {
      const off = await fetchConfig(createTestSettings({ authAllowAnonymous: false }))
      expect(off.body.allowAnonUsers).toBe(false)

      const on = await fetchConfig(createTestSettings({ authAllowAnonymous: true }))
      expect(on.body.allowAnonUsers).toBe(true)
    })

    it('exposes workspace creation policy flags', async () => {
      const { body } = await fetchConfig(
        createTestSettings({
          allowWorkspaceCreationByAnon: true,
          allowWorkspaceCreationByMembers: true,
        }),
      )
      expect(body.allowWorkspaceCreationByAnon).toBe(true)
      expect(body.allowWorkspaceCreationByMembers).toBe(true)
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
  })
})
