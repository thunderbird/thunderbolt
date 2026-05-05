/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import type { Settings } from '@/config/settings'
import { createConfigRoutes } from './config'

describe('Config Routes', () => {
  describe('GET /config', () => {
    it('returns e2eeEnabled: false when disabled', async () => {
      const app = new Elysia().use(createConfigRoutes({ e2eeEnabled: false } as Settings))

      const response = await app.handle(new Request('http://localhost/config'))

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ e2eeEnabled: false, securityWarnings: expect.any(Array) })
    })

    it('returns e2eeEnabled: true when enabled', async () => {
      const app = new Elysia().use(createConfigRoutes({ e2eeEnabled: true } as Settings))

      const response = await app.handle(new Request('http://localhost/config'))

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ e2eeEnabled: true, securityWarnings: expect.any(Array) })
    })

    it('does not require authentication', async () => {
      const app = new Elysia().use(createConfigRoutes({ e2eeEnabled: false } as Settings))

      const response = await app.handle(new Request('http://localhost/config'))

      expect(response.status).toBe(200)
    })
  })
})
