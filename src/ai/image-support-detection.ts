/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { FetchFn } from '@/lib/proxy-fetch'
import { fetchModelsForProvider } from '@/settings/models/model-catalog'
import type { Model } from '@/types'
import type { ImageSupport } from '@shared/defaults/models'
import { getKnownImageSupport, setCachedImageSupport } from './image-support'
import { probeImageSupport } from './image-support-probe'

/** Upper bound on the whole check, catalog lookup and probe included, generous
 *  enough for a cold local model to load. The composer holds the send this long at most. */
export const imageSupportTimeoutMs = 30_000

/** Providers whose model catalogs report image support per model. */
const modalityCatalogProviders: ReadonlySet<Model['provider']> = new Set(['tinfoil', 'openrouter'])

export type DetectImageSupportOptions = {
  /** Ends the check; defaults to a {@link imageSupportTimeoutMs} deadline. */
  readonly signal?: AbortSignal
  readonly fetchCatalog?: typeof fetchModelsForProvider
  readonly probe?: typeof probeImageSupport
}

/** Settle with `promise`, or reject with the abort reason once `signal` aborts, whichever comes first. */
const untilAborted = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })

/** Image support as the provider's catalog reports it, or undefined when the catalog is silent or unreachable. */
const catalogImageSupport = async (
  model: Model,
  fetchCatalog: typeof fetchModelsForProvider,
  signal: AbortSignal,
): Promise<ImageSupport | undefined> => {
  if (!modalityCatalogProviders.has(model.provider)) {
    return undefined
  }
  try {
    // Neither catalog request has its own timeout, so the deadline bounds it here.
    const catalog = await untilAborted(
      fetchCatalog({ provider: model.provider, apiKey: model.apiKey ?? undefined, url: model.url ?? undefined }),
      signal,
    )
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
 * modalities, then a live probe. One deadline covers the catalog and the probe
 * together. Definitive answers are cached, so each model is detected at most once
 * per device.
 *
 * @param model - the selected model, with its connection settings and api key
 * @param getProxyFetch - lazily resolved universal proxy fetch
 * @param options - the deadline, plus seams for the catalog and probe calls
 * @returns whether the model reads images
 * @throws when no verdict is possible. Nothing is cached, so the send goes ahead
 *   and the check runs again after a reload or a composer remount.
 */
export const detectImageSupport = async (
  model: Model,
  getProxyFetch: () => FetchFn,
  {
    signal = AbortSignal.timeout(imageSupportTimeoutMs),
    fetchCatalog = fetchModelsForProvider,
    probe = probeImageSupport,
  }: DetectImageSupportOptions = {},
): Promise<ImageSupport> => {
  const known = getKnownImageSupport(model)
  if (known) {
    return known
  }
  const support =
    (await catalogImageSupport(model, fetchCatalog, signal)) ?? (await probe(model, getProxyFetch, signal))
  setCachedImageSupport(model, support)
  return support
}
