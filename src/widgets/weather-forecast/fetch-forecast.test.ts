/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient, RequestOptions, ResponsePromise } from '@/lib/http'
import { describe, expect, it } from 'bun:test'
import { fetchWeatherForecast } from './fetch-forecast'

type RecordedRequest = { url: string; searchParams: Record<string, string | number | boolean | undefined> }

type FakeRoutes = { geocoding: unknown; forecast: unknown }

/**
 * Build a fake HttpClient that records every requested URL/searchParams and returns canned JSON,
 * routing by hostname (geocoding vs forecast). Only `.get(...).json()` is exercised by the module.
 */
const createFakeHttpClient = (routes: FakeRoutes, recorded: RecordedRequest[]): HttpClient => {
  const respond = (data: unknown): ResponsePromise => {
    const promise = Promise.resolve(new Response(JSON.stringify(data))) as ResponsePromise
    promise.json = async <T>() => data as T
    promise.text = async () => JSON.stringify(data)
    return promise
  }

  const get = (url: string, options?: RequestOptions): ResponsePromise => {
    recorded.push({ url, searchParams: (options?.searchParams ?? {}) as RecordedRequest['searchParams'] })
    return respond(url.includes('geocoding') ? routes.geocoding : routes.forecast)
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
      { location: 'London', region: '', country: '', days: 3, temperatureUnit: 'f' },
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
      { location: 'Paris', region: 'Texas', country: 'United States', days: 3, temperatureUnit: 'c' },
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
      fetchWeatherForecast({ location: 'Nowhere', region: '', country: '', days: 3, temperatureUnit: 'c' }, httpClient),
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
      { location: 'Berlin', region: '', country: '', days: 3, temperatureUnit: 'c' },
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
        { location: 'Reykjavik', region: '', country: '', days: 3, temperatureUnit: 'c' },
        httpClient,
      ),
    ).rejects.toThrow()
  })
})
