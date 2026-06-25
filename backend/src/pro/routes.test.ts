/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createProToolsRoutes } from './routes'

describe('Pro Tools Routes', () => {
  let app: ReturnType<typeof createProToolsRoutes>
  let consoleSpies: ConsoleSpies

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()
    app = createProToolsRoutes(mockAuth)
  })

  afterAll(async () => {
    consoleSpies.restore()
  })

  it('should return error when fetch-content API key is not configured', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/fetch-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      }),
    )

    expect(response.status).toBe(500)
    const data = await response.json()
    // Error handler sanitizes internal error messages for security
    expect(data).toEqual({
      success: false,
      data: null,
      error: 'Internal Server Error',
    })
  })

  describe('authentication', () => {
    it('should return 401 when session is null', async () => {
      const unauthenticatedApp = createProToolsRoutes(mockAuthUnauthenticated)

      const response = await unauthenticatedApp.handle(
        new Request('http://localhost/pro/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(401)
    })
  })

  it('should require valid body for requests', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/fetch-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(response.status).toBe(422) // Elysia validation error
  })
})
