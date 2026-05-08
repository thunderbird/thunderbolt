/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { createApp } from '@/index'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

describe('Swagger', () => {
  let savedSwaggerEnabled: string | undefined
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    savedSwaggerEnabled = process.env.SWAGGER_ENABLED
    clearSettingsCache()
    // Use the pre-migrated test database so createAuth's health check passes.
    // The swagger test only cares about route exposure, not auth behaviour.
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    if (savedSwaggerEnabled !== undefined) {
      process.env.SWAGGER_ENABLED = savedSwaggerEnabled
    } else {
      delete process.env.SWAGGER_ENABLED
    }
    clearSettingsCache()
    await cleanup()
  })

  it('should NOT expose /v1/swagger when SWAGGER_ENABLED is unset', async () => {
    delete process.env.SWAGGER_ENABLED
    const app = await createApp({ database: db })
    const res = await app.handle(new Request('http://localhost/v1/swagger'))
    expect(res.status).toBe(404)
  })

  it('should expose /v1/swagger when SWAGGER_ENABLED=true', async () => {
    process.env.SWAGGER_ENABLED = 'true'
    const app = await createApp({ database: db })
    const res = await app.handle(new Request('http://localhost/v1/swagger'))
    expect(res.status).not.toBe(404)
  })

  it('should NOT expose /v1/swagger when SWAGGER_ENABLED=false', async () => {
    process.env.SWAGGER_ENABLED = 'false'
    const app = await createApp({ database: db })
    const res = await app.handle(new Request('http://localhost/v1/swagger'))
    expect(res.status).toBe(404)
  })
})
