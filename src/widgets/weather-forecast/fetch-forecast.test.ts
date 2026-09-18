/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient, RequestOptions, ResponsePromise } from '@/lib/http'
import { describe, expect, it } from 'bun:test'
import { fetchWeatherForecast } from './fetch-forecast'

type RecordedRequest = { url: string; searchParams: Record<string, string | number | boolean | undefined> }

type FakeRoutes = { geocoding: unknown; forecast: unknown; localizedPlace?: unknown }

/**
 * Build a fake HttpClient that records every requested URL/searchParams and returns canned JSON,
 * routing by endpoint (geocoding search vs by-id lookup vs forecast). Only `.get(...).json()` is
 * exercised by the module. A `localizedPlace` of `undefined` stands in for the by-id lookup failing.
 */
const createFakeHttpClient = (routes: FakeRoutes, recorded: RecordedRequest[]): HttpClient => {
  const respond = (data: unknown): ResponsePromise => {
    const promise = Promise.resolve(new Response(JSON.stringify(data))) as ResponsePromise
    promise.json = async <T>() => data as T
    promise.text = async () => JSON.stringify(data)
    return promise
  }

  const routeFor = (url: string): unknown => {
    if (url.includes('/v1/get')) {
      if (!routes.localizedPlace) {
        throw new Error('by-id lookup unavailable')
      }
      return routes.localizedPlace
    }
    return url.includes('geocoding') ? routes.geocoding : routes.forecast
  }

  const get = (url: string, options?: RequestOptions): ResponsePromise => {
    recorded.push({ url, searchParams: (options?.searchParams ?? {}) as RecordedRequest['searchParams'] })
    return respond(routeFor(url))
  }

  const unsupported = (): ResponsePromise => {
    throw new Error('not implemented')
  }

  return { get, post: unsupported, delete: unsupported }
}

const buildForecast = (count: number) => ({
  daily: {
    time: Array.from({ length: count }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`),
    weather_code: Array.from({ length: count }, (_, i) => i),
    temperature_2m_max: Array.from({ length: count }, (_, i) => 20 + i),
  },
})

describe('fetchWeatherForecast', () => {
  it('geocodes then fetches the forecast and returns the mapped shape', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: {
          results: [{ name: 'London', admin1: 'England', country: 'United Kingdom', latitude: 51.5, longitude: -0.12 }],
        },
        forecast: buildForecast(3),
      },
      recorded,
    )

    const result = await fetchWeatherForecast(
      { location: 'London', region: '', country: '', days: 3, temperatureUnit: 'f', locale: 'en' },
      httpClient,
    )

    expect(result.location).toBe('London, England, United Kingdom')
    expect(result.temperature_unit).toBe('f')
    expect(result.days).toHaveLength(3)
    expect(result.days[0]).toEqual({
      date: '2024-01-01',
      weather_code: 0,
      temperature_max: 20,
    })

    expect(recorded).toHaveLength(2)
    expect(recorded[0].url).toContain('geocoding-api.open-meteo.com')
    expect(recorded[0].searchParams.name).toBe('London')
    expect(recorded[1].url).toContain('api.open-meteo.com/v1/forecast')
    expect(recorded[1].searchParams.temperature_unit).toBe('fahrenheit')
  })

  /**
   * Geocoding stays English whatever the UI language is. `region`/`country` come
   * from the model's widget arguments and are usually English, so localizing the
   * response would break `disambiguateLocation` — the country filter would match
   * nothing and `narrowMatches` would fall back to every candidate, silently
   * returning the wrong city's forecast.
   */
  it('geocodes in English even when the UI is in another language', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: { results: [{ id: 3390760, name: 'Recife', latitude: -8.05, longitude: -34.9 }] },
        forecast: buildForecast(1),
        localizedPlace: { id: 3390760, name: 'Recife', admin1: 'Pernambuco', country: 'Brasil' },
      },
      recorded,
    )

    await fetchWeatherForecast(
      { location: 'Recife', region: '', country: '', days: 1, temperatureUnit: 'c', locale: 'pt-BR' },
      httpClient,
    )

    expect(recorded[0].searchParams.language).toBe('en')
  })

  // The disambiguation above must hold regardless of UI language — the test that
  // exercises it runs in English, so this pins the non-English case.
  it('still disambiguates by region and country when the UI is in another language', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: {
          results: [
            {
              id: 2988507,
              name: 'Paris',
              admin1: 'Île-de-France',
              country: 'France',
              latitude: 48.85,
              longitude: 2.35,
            },
            {
              id: 4717560,
              name: 'Paris',
              admin1: 'Texas',
              country: 'United States',
              latitude: 33.66,
              longitude: -95.55,
            },
          ],
        },
        forecast: buildForecast(1),
        localizedPlace: { id: 4717560, name: 'Paris', admin1: 'Texas', country: 'États-Unis' },
      },
      recorded,
    )

    const result = await fetchWeatherForecast(
      { location: 'Paris', region: 'Texas', country: 'United States', days: 1, temperatureUnit: 'c', locale: 'fr' },
      httpClient,
    )

    expect(result.location).toBe('Paris, Texas, États-Unis')
    expect(recorded[1].searchParams.latitude).toBe(33.66)
  })

  // The by-id lookup keys off the disambiguated winner, so it cannot re-open the
  // Paris-Texas question — but it does have to ask for the base subtag, since
  // Open-Meteo answers `pt-BR` in English.
  it('localizes the displayed name by id, using the base language subtag', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: {
          results: [
            { id: 2867714, name: 'Munich', admin1: 'Bavaria', country: 'Germany', latitude: 48.1, longitude: 11.6 },
          ],
        },
        forecast: buildForecast(1),
        localizedPlace: { id: 2867714, name: 'Munique', admin1: 'Baviera', country: 'Alemanha' },
      },
      recorded,
    )

    const result = await fetchWeatherForecast(
      { location: 'Munich', region: '', country: '', days: 1, temperatureUnit: 'c', locale: 'pt-BR' },
      httpClient,
    )

    expect(result.location).toBe('Munique, Baviera, Alemanha')
    const byId = recorded.find((request) => request.url.includes('/v1/get'))
    expect(byId?.searchParams).toMatchObject({ id: 2867714, language: 'pt' })
  })

  it('falls back to the English name when the by-id lookup fails', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: {
          results: [
            { id: 2867714, name: 'Munich', admin1: 'Bavaria', country: 'Germany', latitude: 48.1, longitude: 11.6 },
          ],
        },
        forecast: buildForecast(1),
      },
      recorded,
    )

    const result = await fetchWeatherForecast(
      { location: 'Munich', region: '', country: '', days: 1, temperatureUnit: 'c', locale: 'ja' },
      httpClient,
    )

    expect(result.location).toBe('Munich, Bavaria, Germany')
  })

  it('skips the by-id lookup entirely under English', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: {
          results: [
            { id: 2867714, name: 'Munich', admin1: 'Bavaria', country: 'Germany', latitude: 48.1, longitude: 11.6 },
          ],
        },
        forecast: buildForecast(1),
      },
      recorded,
    )

    await fetchWeatherForecast(
      { location: 'Munich', region: '', country: '', days: 1, temperatureUnit: 'c', locale: 'en' },
      httpClient,
    )

    expect(recorded).toHaveLength(2)
  })

  it('disambiguates by region and country, selecting the matching result', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: {
          results: [
            { name: 'Paris', admin1: 'Île-de-France', country: 'France', latitude: 48.85, longitude: 2.35 },
            { name: 'Paris', admin1: 'Texas', country: 'United States', latitude: 33.66, longitude: -95.55 },
          ],
        },
        forecast: buildForecast(3),
      },
      recorded,
    )

    const result = await fetchWeatherForecast(
      { location: 'Paris', region: 'Texas', country: 'United States', days: 3, temperatureUnit: 'c', locale: 'en' },
      httpClient,
    )

    expect(result.location).toBe('Paris, Texas, United States')
    expect(recorded[1].searchParams.latitude).toBe(33.66)
    expect(recorded[1].searchParams.temperature_unit).toBe('celsius')
  })

  it('throws when geocoding returns no results', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient({ geocoding: { results: [] }, forecast: buildForecast(3) }, recorded)

    await expect(
      fetchWeatherForecast(
        { location: 'Nowhere', region: '', country: '', days: 3, temperatureUnit: 'c', locale: 'en' },
        httpClient,
      ),
    ).rejects.toThrow("Could not find coordinates for location 'Nowhere'")

    expect(recorded).toHaveLength(1)
  })

  it('maps exactly `days` entries even when the forecast returns more', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: {
          results: [{ name: 'Berlin', admin1: 'Berlin', country: 'Germany', latitude: 52.5, longitude: 13.4 }],
        },
        forecast: buildForecast(7),
      },
      recorded,
    )

    const result = await fetchWeatherForecast(
      { location: 'Berlin', region: '', country: '', days: 3, temperatureUnit: 'c', locale: 'en' },
      httpClient,
    )

    expect(result.days).toHaveLength(3)
  })

  it('rejects when the forecast is empty (schema requires at least one day)', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      {
        geocoding: {
          results: [{ name: 'Reykjavik', admin1: '', country: 'Iceland', latitude: 64.15, longitude: -21.94 }],
        },
        forecast: buildForecast(0),
      },
      recorded,
    )

    await expect(
      fetchWeatherForecast(
        { location: 'Reykjavik', region: '', country: '', days: 3, temperatureUnit: 'c', locale: 'en' },
        httpClient,
      ),
    ).rejects.toThrow()
  })
})
