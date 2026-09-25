/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { FetchFn } from '@/lib/proxy-fetch'
import { fetchModelsForProvider } from '@/settings/models/model-catalog'
import type { Model } from '@/types'
import type { ImageSupport } from '@shared/defaults/models'
import { getKnownImageSupport, setCachedImageSupport } from './image-support'
import { probeImageSupport } from './image-support-probe'

/** Providers whose model catalogs report image support per model. */
const modalityCatalogProviders: ReadonlySet<Model['provider']> = new Set(['tinfoil', 'openrouter'])

export type ImageSupportDetectionDeps = {
  readonly fetchCatalog: typeof fetchModelsForProvider
  readonly probe: typeof probeImageSupport
}

const defaultDeps: ImageSupportDetectionDeps = { fetchCatalog: fetchModelsForProvider, probe: probeImageSupport }

/** Image support as the provider's catalog reports it, or undefined when the catalog is silent or unreachable. */
const catalogImageSupport = async (
  model: Model,
  fetchCatalog: ImageSupportDetectionDeps['fetchCatalog'],
): Promise<ImageSupport | undefined> => {
  if (!modalityCatalogProviders.has(model.provider)) {
    return undefined
  }
  try {
    const catalog = await fetchCatalog({
      provider: model.provider,
      apiKey: model.apiKey ?? undefined,
      url: model.url ?? undefined,
    })
    const supportsImages = catalog.find((entry) => entry.id === model.model)?.supports_images
    if (supportsImages === undefined) {
      return undefined
    }
    return supportsImages ? 'supported' : 'unsupported'
  } catch (error) {
    // A catalog outage shouldn't block the answer; the probe can still get one.
    console.warn('Image support catalog lookup failed; probing the model instead', error)
    return undefined
  }
}

/**
 * Work out whether a model can read images, cheapest source first: the fixed
 * rules and this device's cache, then the provider's catalog where it publishes
 * modalities, then a live probe. Definitive answers are cached, so each model is
 * detected at most once per device.
 *
 * @param model - the selected model, with its connection settings and api key
 * @param getProxyFetch - lazily resolved universal proxy fetch
 * @returns whether the model reads images
 * @throws when no verdict is possible (nothing is cached; the send should go ahead)
 */
export const detectImageSupport = async (
  model: Model,
  getProxyFetch: () => FetchFn,
  deps: ImageSupportDetectionDeps = defaultDeps,
): Promise<ImageSupport> => {
  const known = getKnownImageSupport(model)
  if (known) {
    return known
  }
  const support = (await catalogImageSupport(model, deps.fetchCatalog)) ?? (await deps.probe(model, getProxyFetch))
  setCachedImageSupport(model, support)
  return support
}
