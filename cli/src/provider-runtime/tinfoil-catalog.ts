/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  createReasoningCatalogLoader,
  parseTinfoilReasoningCatalog,
  tinfoilModelsUrl,
} from '../../../shared/reasoning-effort-catalog.ts'
import { noReasoningEffort } from '../../../shared/reasoning-effort.ts'
import type { AccountFetch } from './types.ts'

/** Discover public capability metadata without sending session credentials or using the attested inference channel. */
export const createTinfoilReasoningLoader = (fetchFn?: AccountFetch) => {
  const loadCatalog = createReasoningCatalogLoader('Tinfoil', async () => {
    const init = {
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    } as const
    const response = await (fetchFn ? fetchFn(tinfoilModelsUrl, init) : fetch(tinfoilModelsUrl, init))
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Tinfoil model catalog request failed with HTTP ${response.status}`)
    }
    return parseTinfoilReasoningCatalog(await response.json())
  })
  return async (modelId: string) => (await loadCatalog()).get(modelId) ?? noReasoningEffort
}

export const loadTinfoilReasoningCapabilities = createTinfoilReasoningLoader()
