/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isRecord } from './lib/is-record.ts'
import { reasoningEfforts, type ReasoningCapabilities } from './reasoning-effort.ts'

export const tinfoilModelsUrl = 'https://inference.tinfoil.sh/v1/models'

/** Read native effort support, never the provider's lossy low/medium/high preset map. */
export const parseTinfoilReasoningCatalog = (value: unknown): Map<string, ReasoningCapabilities> => {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Invalid Tinfoil model catalog')
  }
  return new Map(
    value.data.map((row) => {
      if (
        !isRecord(row) ||
        typeof row.id !== 'string' ||
        (row.reasoning != null && typeof row.reasoning !== 'boolean') ||
        (row.supported_efforts != null &&
          (!Array.isArray(row.supported_efforts) || row.supported_efforts.some((effort) => typeof effort !== 'string')))
      ) {
        throw new Error('Invalid Tinfoil model reasoning metadata')
      }
      const supported = row.reasoning === true && Array.isArray(row.supported_efforts) ? row.supported_efforts : []
      return [row.id, { efforts: reasoningEfforts.filter((effort) => supported.includes(effort)) }]
    }),
  )
}

/** Share pending discovery and cache successful catalogs for five minutes, including across refresh outages. */
export const createReasoningCatalogLoader = <T>(provider: string, load: () => Promise<T>): (() => Promise<T>) => {
  const cache: { current?: { expires: number; value: Promise<T> } } = {}
  return () => {
    const previous = cache.current
    if (previous && previous.expires > Date.now()) {
      return previous.value
    }
    const value = (async () => {
      try {
        return await load()
      } catch (error) {
        if (previous) {
          console.warn(`Could not refresh ${provider} reasoning capabilities; using the previous catalog`, error)
          return previous.value
        }
        delete cache.current
        throw error
      } finally {
        if (cache.current) {
          cache.current.expires = Date.now() + 300_000
        }
      }
    })()
    // A suspended tab must still share the request that was already in flight.
    cache.current = { expires: Infinity, value }
    return value
  }
}
