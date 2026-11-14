/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import * as settingsModule from '@/config/settings'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { insertTestUsers } from '@/test-utils/identity'
import { createScimClient, uniqueSuffix } from '@/test-utils/scim'
import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createScimConnection } from './connections'
import { deriveScimCredentialHashSecret } from './plugin'

describe('deriveScimCredentialHashSecret', () => {
  it('is deterministic, long enough for the plugin, and follows BETTER_AUTH_SECRET', () => {
    const secret = deriveScimCredentialHashSecret('a-better-auth-secret')
    expect(deriveScimCredentialHashSecret('a-better-auth-secret')).toBe(secret)
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(secret).not.toContain('a-better-auth-secret')
    expect(deriveScimCredentialHashSecret('another-secret')).not.toBe(secret)
  })

  it('stops every SCIM token when BETTER_AUTH_SECRET changes', async () => {
    const { db } = await getSharedIsolatedTestDb()
    const current = createBetterAuthPlugin(db)
    const actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
    const { token } = await createScimConnection(current.auth, { actorId, name: `Secret ${uniqueSuffix()}` })

    const settings = settingsModule.getSettings()
    const settingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      ...settings,
      betterAuthSecret: 'a-rotated-better-auth-secret-0123456789',
    })
    try {
      const rotated = createBetterAuthPlugin(db)
      const statusOn = async (plugin: typeof current) =>
        (
          await createScimClient(
            (request) => new Elysia({ prefix: '/v1' }).use(plugin.plugin).handle(request),
            token,
          ).call('GET', '/Users')
        ).status
      expect(await statusOn(current)).toBe(200)
      expect(await statusOn(rotated)).toBe(401)
    } finally {
      settingsSpy.mockRestore()
    }
  })
})
