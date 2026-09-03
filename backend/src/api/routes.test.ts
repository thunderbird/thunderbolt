/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createMainRoutes } from './routes'

describe('Main Routes', () => {
  let app: ReturnType<typeof createMainRoutes>
  let consoleSpies: ConsoleSpies

  const mockFetch = mock((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const { hostname } = new URL(url)
    if (hostname === 'geocoding-api.open-meteo.com') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                name: 'London',
                admin1: 'England',
                country: 'UK',
                country_code: 'GB',
                latitude: 51.5,
                longitude: -0.12,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  })

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    app = createMainRoutes(mockAuth, mockFetch as unknown as typeof fetch)
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  describe('auth guard', () => {
    let unauthApp: ReturnType<typeof createMainRoutes>

    beforeAll(() => {
      unauthApp = createMainRoutes(mockAuthUnauthenticated, mockFetch as unknown as typeof fetch)
    })

    it('should allow unauthenticated requests to /health', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/health'))
      expect(response.status).toBe(200)
    })

    it('should reject unauthenticated requests to /locations', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/locations?query=London'))
      expect(response.status).toBe(401)
    })
  })

  it('should return health status', async () => {
    const response = await app.handle(new Request('http://localhost/health'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toEqual({ status: 'ok' })
  })

  it('should require query parameter for locations endpoint', async () => {
    const response = await app.handle(new Request('http://localhost/locations'))
    expect(response.status).toBe(422) // Elysia validation error
  })

  it('should search locations with valid query', async () => {
    const response = await app.handle(new Request('http://localhost/locations?query=London'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toEqual([
      { id: 0, name: 'London', region: 'England', country: 'UK', countryCode: 'GB', lat: 51.5, lon: -0.12 },
    ])
  })

  /**
   * Open-Meteo's `language` narrows what it *matches*, not just what it renders:
   * `Munique` finds Munich under `pt` and only Muñique, Spain under `en`. And it
   * keys on the base subtag — `pt-BR` falls off the lookup path and silently
   * answers in English — so the route has to hand it `pt`, not the caller's tag.
   */
  it('should search in the requested language, narrowed to its base subtag', async () => {
    const requested: string[] = []
    const recordingFetch = mock((input: RequestInfo | URL) => {
      requested.push(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })

    const testApp = createMainRoutes(mockAuth, recordingFetch as unknown as typeof fetch)
    await testApp.handle(new Request('http://localhost/locations?query=Munique&language=pt-BR'))

    expect(new URL(requested[0]).searchParams.get('language')).toBe('pt')
  })

  it('should default to English when no language is given', async () => {
    const requested: string[] = []
    const recordingFetch = mock((input: RequestInfo | URL) => {
      requested.push(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })

    const testApp = createMainRoutes(mockAuth, recordingFetch as unknown as typeof fetch)
    await testApp.handle(new Request('http://localhost/locations?query=London'))

    expect(new URL(requested[0]).searchParams.get('language')).toBe('en')
  })

  /**
   * `baseLanguage` builds an `Intl.Locale`, which throws a `RangeError` on a
   * malformed tag, and `?language=` arrives as `''` rather than as a missing
   * value — so it slips past the `'en'` default. Both have to be turned away at
   * the boundary; reaching the handler makes them an opaque 500.
   */
  it.each(['', 'en_US', 'foo!', 'e', 'en-'])('should reject the malformed language tag %p', async (language) => {
    const unreachedFetch = mock(() => Promise.resolve(new Response('{}', { status: 200 })))
    const testApp = createMainRoutes(mockAuth, unreachedFetch as unknown as typeof fetch)
    const response = await testApp.handle(
      new Request(`http://localhost/locations?query=London&language=${encodeURIComponent(language)}`),
    )

    expect(response.status).toBe(422)
    expect(unreachedFetch).not.toHaveBeenCalled()
  })

  describe('GET /locations/:id', () => {
    const byIdFetch = mock((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: 2867714,
            name: (input instanceof Request ? input.url : input.toString()).includes('language=pt')
              ? 'Munique'
              : 'Munich',
            admin1: 'Baviera',
            country: 'Alemanha',
            country_code: 'DE',
            latitude: 48.13,
            longitude: 11.57,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    it('should resolve a place by id in the requested language', async () => {
      const testApp = createMainRoutes(mockAuth, byIdFetch as unknown as typeof fetch)
      const response = await testApp.handle(new Request('http://localhost/locations/2867714?language=pt-BR'))
      expect(response.status).toBe(200)

      expect(await response.json()).toEqual({
        id: 2867714,
        name: 'Munique',
        region: 'Baviera',
        country: 'Alemanha',
        countryCode: 'DE',
        lat: 48.13,
        lon: 11.57,
      })
    })

    it('should reject a non-numeric id', async () => {
      const testApp = createMainRoutes(mockAuth, byIdFetch as unknown as typeof fetch)
      const response = await testApp.handle(new Request('http://localhost/locations/not-an-id'))
      expect(response.status).toBe(422)
    })

    it('should 404 when the provider does not know the id', async () => {
      const missingFetch = mock(() => Promise.resolve(new Response('{}', { status: 400 })))
      const testApp = createMainRoutes(mockAuth, missingFetch as unknown as typeof fetch)
      const response = await testApp.handle(new Request('http://localhost/locations/1?language=de'))
      expect(response.status).toBe(404)
    })

    it('should reject unauthenticated requests', async () => {
      const testApp = createMainRoutes(mockAuthUnauthenticated, byIdFetch as unknown as typeof fetch)
      const response = await testApp.handle(new Request('http://localhost/locations/2867714'))
      expect(response.status).toBe(401)
    })

    it('should reject a malformed language tag', async () => {
      const unreachedFetch = mock(() => Promise.resolve(new Response('{}', { status: 200 })))
      const testApp = createMainRoutes(mockAuth, unreachedFetch as unknown as typeof fetch)
      const response = await testApp.handle(new Request('http://localhost/locations/2867714?language='))

      expect(response.status).toBe(422)
      expect(unreachedFetch).not.toHaveBeenCalled()
    })
  })

  it('should return an empty country code when the provider omits one', async () => {
    const mockFetchWithoutCode = mock((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (new URL(url).hostname === 'geocoding-api.open-meteo.com') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ results: [{ name: 'Atlantis', admin1: 'Unknown', latitude: 0, longitude: 0 }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })

    const testApp = createMainRoutes(mockAuth, mockFetchWithoutCode as unknown as typeof fetch)
    const response = await testApp.handle(new Request('http://localhost/locations?query=Atlantis'))

    const data = await response.json()
    expect(data[0].countryCode).toBe('')
  })

  it('should filter out country-level results without admin1', async () => {
    const mockFetchWithCountry = mock((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      const { hostname } = new URL(url)
      if (hostname === 'geocoding-api.open-meteo.com') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  id: 6251999,
                  name: 'Canada',
                  country: 'Canada',
                  country_code: 'CA',
                  latitude: 60.1,
                  longitude: -113.6,
                },
                {
                  id: 4298960,
                  name: 'Canada',
                  admin1: 'Kentucky',
                  country: 'United States',
                  country_code: 'US',
                  latitude: 37.6,
                  longitude: -82.3,
                },
                {
                  id: 2521850,
                  name: 'Cañada',
                  admin1: 'Valencia',
                  country: 'Spain',
                  country_code: 'ES',
                  latitude: 38.7,
                  longitude: -0.8,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })

    const testApp = createMainRoutes(mockAuth, mockFetchWithCountry as unknown as typeof fetch)

    const response = await testApp.handle(new Request('http://localhost/locations?query=Canada'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(2)
    expect(data.every((loc: { region: string }) => loc.region !== '')).toBe(true)
    expect(data).toEqual([
      {
        id: 4298960,
        name: 'Canada',
        region: 'Kentucky',
        country: 'United States',
        countryCode: 'US',
        lat: 37.6,
        lon: -82.3,
      },
      { id: 2521850, name: 'Cañada', region: 'Valencia', country: 'Spain', countryCode: 'ES', lat: 38.7, lon: -0.8 },
    ])
  })
})
