/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createDiscoveryRoutes } from './routes'

const settings = {
  discoveryServerMap: JSON.stringify({
    'acme.com': 'https://acme.thunderbolt.io',
    'vip@example.com': 'https://vip.example.io',
  }),
  discoveryDefaultServerUrl: 'https://public.thunderbolt.io',
  appUrl: 'http://localhost:1420',
}

const buildApp = (overrides: Partial<typeof settings> = {}) =>
  new Elysia().use(createDiscoveryRoutes({ ...settings, ...overrides }))

const post = (app: { handle: Elysia['handle'] }, body: unknown) =>
  app.handle(
    new Request('http://localhost/discovery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('createDiscoveryRoutes', () => {
  it('returns the mapped server URL for a domain match', async () => {
    const res = await post(buildApp(), { email: 'someone@acme.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ serverUrl: 'https://acme.thunderbolt.io' })
  })

  it('prefers an exact email match over the domain', async () => {
    const res = await post(buildApp(), { email: 'vip@example.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ serverUrl: 'https://vip.example.io' })
  })

  it('is case-insensitive on the email', async () => {
    const res = await post(buildApp(), { email: 'Someone@ACME.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ serverUrl: 'https://acme.thunderbolt.io' })
  })

  it('returns a UNIFORM response (default server, 200) for an unmatched email', async () => {
    const res = await post(buildApp(), { email: 'nobody@unknown-domain.com' })
    // Same shape + status as a match — never leaks match/no-match.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ serverUrl: 'https://public.thunderbolt.io' })
  })

  it('falls back to appUrl when no default server URL is configured', async () => {
    const res = await post(buildApp({ discoveryDefaultServerUrl: '' }), { email: 'nobody@unknown.com' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ serverUrl: 'http://localhost:1420' })
  })

  it('rejects a malformed email with a validation error (not 200)', async () => {
    const res = await post(buildApp(), { email: 'not-an-email' })
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('rejects a missing email field', async () => {
    const res = await post(buildApp(), {})
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
