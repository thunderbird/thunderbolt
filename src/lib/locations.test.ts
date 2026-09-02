/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient, RequestOptions, ResponsePromise } from '@/lib/http'
import { describe, expect, it } from 'bun:test'
import { fetchEnglishLocationName, fetchLocationById, fetchLocations } from './locations'

type RecordedRequest = { url: string; searchParams: Record<string, unknown> }

const createFakeHttpClient = (payload: unknown, recorded: RecordedRequest[]): HttpClient => {
  const get = (url: string, options?: RequestOptions): ResponsePromise => {
    recorded.push({ url, searchParams: (options?.searchParams ?? {}) as Record<string, unknown> })
    const promise = Promise.resolve(new Response(JSON.stringify(payload))) as ResponsePromise
    promise.json = async <T>() => payload as T
    promise.text = async () => JSON.stringify(payload)
    return promise
  }

  const unsupported = (): ResponsePromise => {
    throw new Error('not implemented')
  }

  return { get, post: unsupported, delete: unsupported }
}

const munich = {
  id: 2867714,
  name: 'Munich',
  region: 'Bavaria',
  country: 'Germany',
  countryCode: 'DE',
  lat: 48.13,
  lon: 11.57,
}

describe('fetchLocations', () => {
  it('joins the display name and passes the language through', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(
      [{ ...munich, name: 'Munique', region: 'Baviera', country: 'Alemanha' }],
      recorded,
    )

    const [result] = await fetchLocations(httpClient, 'Munique', 'pt-BR')

    expect(result).toEqual({
      id: 2867714,
      name: 'Munique, Baviera, Alemanha',
      city: 'Munique',
      countryCode: 'DE',
      coordinates: { lat: 48.13, lng: 11.57 },
    })
    expect(recorded[0].searchParams).toEqual({ query: 'Munique', language: 'pt-BR' })
  })

  it('omits missing parts rather than leaving empty segments in the name', async () => {
    const httpClient = createFakeHttpClient([{ ...munich, region: '', countryCode: '' }], [])

    const [result] = await fetchLocations(httpClient, 'Munich', 'en')

    expect(result.name).toBe('Munich, Germany')
  })
})

describe('fetchLocationById', () => {
  it('requests the id path with the given language', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(munich, recorded)

    const result = await fetchLocationById(httpClient, 2867714, 'de')

    expect(result.id).toBe(2867714)
    expect(recorded[0].url).toBe('locations/2867714')
    expect(recorded[0].searchParams).toEqual({ language: 'de' })
  })
})

describe('fetchEnglishLocationName', () => {
  /**
   * `location_name` is model-facing, so it has to come back in English even
   * though the picker searched — and displayed — in the user's language.
   */
  it('re-resolves the place in English when the picker was not English', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(munich, recorded)

    const name = await fetchEnglishLocationName(httpClient, 2867714, 'Munique, Baviera, Alemanha', 'pt-BR')

    expect(name).toBe('Munich, Bavaria, Germany')
    expect(recorded[0].searchParams).toEqual({ language: 'en' })
  })

  /**
   * Deliberately not a fallback to the localized name: `location_name` is
   * model-facing, so storing a localized value would silently break the weather
   * widget's English disambiguation. Callers abort the save and say so instead.
   */
  it('rejects rather than falling back when the lookup fails', async () => {
    const failing: HttpClient = {
      get: (): ResponsePromise => {
        const rejected = Promise.resolve() as unknown as ResponsePromise
        rejected.json = () => Promise.reject(new Error('geocoding unavailable'))
        rejected.text = () => Promise.reject(new Error('geocoding unavailable'))
        return rejected
      },
      post: () => {
        throw new Error('not implemented')
      },
      delete: () => {
        throw new Error('not implemented')
      },
    }

    await expect(fetchEnglishLocationName(failing, 2867714, 'Munique, Baviera, Alemanha', 'pt-BR')).rejects.toThrow(
      'geocoding unavailable',
    )
  })

  it('skips the round trip when the picker was already English', async () => {
    const recorded: RecordedRequest[] = []
    const httpClient = createFakeHttpClient(munich, recorded)

    const name = await fetchEnglishLocationName(httpClient, 2867714, 'Munich, Bavaria, Germany', 'en')

    expect(name).toBe('Munich, Bavaria, Germany')
    expect(recorded).toHaveLength(0)
  })
})
