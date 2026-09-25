/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether a model can read image attachments, answered without the network: the
 * shared fixed rules, then this device's cache of earlier detections. Deliberately
 * light so the composer can import it statically; the network-backed detection
 * that fills the cache lives in `image-support-detection.ts` and loads on demand.
 *
 * Cached per device in localStorage rather than on the synced `models` row, so a
 * result never needs a schema change or sync-rule deploy. Each device detects once.
 */

import { type ImageSupport, type ImageSupportModel, staticImageSupport } from '@shared/defaults/models'
import { z } from 'zod'

const storageKey = 'thunderbolt_image_support'

const cacheSchema = z.record(z.string(), z.enum(['supported', 'unsupported']))

/** Cache key for a model: the endpoint and model slug, not the row. */
export const imageSupportKey = (model: ImageSupportModel): string =>
  JSON.stringify([model.provider, model.url ?? '', model.model])

const readCache = (): Record<string, ImageSupport> => {
  const raw = localStorage.getItem(storageKey)
  if (!raw) {
    return {}
  }
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/** A previous detection result for this model on this device, if any. */
export const getCachedImageSupport = (model: ImageSupportModel): ImageSupport | undefined =>
  readCache()[imageSupportKey(model)]

/** Record a detection result or a user override. Best-effort: a rejected write only means detecting again later. */
export const setCachedImageSupport = (model: ImageSupportModel, support: ImageSupport): void => {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ ...readCache(), [imageSupportKey(model)]: support }))
  } catch {
    // Quota exceeded or storage unavailable.
  }
}

/** Forget every detection result (on sign-out and data wipes). */
export const clearImageSupportCache = (): void => {
  localStorage.removeItem(storageKey)
}

/** Image support known right now without a network call, or undefined when it still needs detecting. */
export const getKnownImageSupport = (model: ImageSupportModel): ImageSupport | undefined =>
  staticImageSupport(model) ?? getCachedImageSupport(model)
