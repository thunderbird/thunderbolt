/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  defaultModelId,
  defaultModelImageSupport,
  defaultModels,
  defaultModelsVersion,
  type ImageSupport,
  type SharedModel,
  staticImageSupport,
} from '../../../shared/defaults/models.ts'
import { backendHeaders, isSecureCloudUrl } from '../auth/config.ts'
import { abortable, settleBestEffort } from '../lib/abort.ts'
import { isNonblankString, isRecord } from '../lib/json.ts'
import { providerRuntimeError } from './types.ts'
import type { ManagedCatalog, ManagedCatalogLoader } from './types.ts'

const catalogRequestTimeoutMs = 5_000

/** Creates the stable malformed-catalog error. */
const invalidCatalogError = () => providerRuntimeError('config-invalid', 'Managed model catalog response is invalid')

/** Creates the stable managed-catalog network error. */
const networkError = (message = 'Unable to fetch the managed model catalog') => providerRuntimeError('network', message)

export const bundledManagedCatalog = {
  version: defaultModelsVersion,
  defaultModelId,
  data: [...defaultModels],
  imageSupport: defaultModelImageSupport,
} satisfies ManagedCatalog

/** Whether a payload value is an image-support map keyed by model id. */
const isImageSupportMap = (value: unknown): value is Record<string, ImageSupport> =>
  isRecord(value) && Object.values(value).every((support) => support === 'supported' || support === 'unsupported')

/**
 * Image support for a backend that predates the map: what the bundled lineup says
 * about each row, matched by provider and model slug rather than id, since a row
 * can keep its id while the backend still serves the model it replaced.
 */
const bundledImageSupport = (data: readonly SharedModel[]): Record<string, ImageSupport> =>
  Object.fromEntries(
    data.flatMap((model): [string, ImageSupport][] => {
      const support = staticImageSupport(model, bundledManagedCatalog)
      return support ? [[model.id, support]] : []
    }),
  )

/** Builds the fixed public config URL after enforcing the secure-origin policy. */
const catalogUrl = (backendUrl: string): string => {
  if (!URL.canParse(backendUrl)) {
    throw providerRuntimeError('config-invalid', 'Managed model catalog backend URL is invalid or insecure')
  }
  const url = new URL(backendUrl)
  if (url.username !== '' || url.password !== '' || !isSecureCloudUrl(url.href)) {
    throw providerRuntimeError('config-invalid', 'Managed model catalog backend URL is invalid or insecure')
  }
  url.search = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/config`
  return url.href
}

/** Fetches and validates the public managed-model catalog. */
export const fetchManagedCatalog: ManagedCatalogLoader = async (backendUrl, fetchFn, timeoutMs) => {
  const signal = AbortSignal.timeout(timeoutMs ?? catalogRequestTimeoutMs)
  const init = { method: 'GET', headers: backendHeaders({ accept: 'application/json' }), redirect: 'error', signal } as const
  const url = catalogUrl(backendUrl)
  // Fetch failure classes are runtime-specific (Bun rejects with a plain Error), so both boundaries map every rejection.
  const response = await (async (): Promise<Response> => {
    try {
      return await abortable(fetchFn ? fetchFn(url, init) : fetch(url, init), signal)
    } catch {
      throw networkError()
    }
  })()
  if (!response.ok) {
    if (response.body) void settleBestEffort(response.body.cancel())
    throw networkError(`Managed model catalog request failed with HTTP ${response.status}`)
  }
  const body = await (async (): Promise<string> => {
    try {
      return await response.text()
    } catch {
      throw networkError()
    }
  })()
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed) || !isRecord(parsed.defaults) || !isRecord(parsed.defaults.models)) {
      throw invalidCatalogError()
    }
    const models = parsed.defaults.models
    if (!Array.isArray(models.data)) throw invalidCatalogError()
    const data = models.data
    const imageSupport = models.imageSupport
    const dataIsValid = data.every(
      (model): model is SharedModel =>
        isRecord(model) &&
        isNonblankString(model.id) &&
        isNonblankString(model.model) &&
        isNonblankString(model.name) &&
        (typeof model.vendor === 'string' || model.vendor === null) &&
        (typeof model.description === 'string' || model.description === null) &&
        (model.isConfidential === 0 || model.isConfidential === 1) &&
        Number.isFinite(model.contextWindow),
    )
    if (
      !Number.isSafeInteger(models.version) ||
      Number(models.version) <= 0 ||
      !isNonblankString(models.defaultModelId) ||
      !dataIsValid ||
      !data.some(({ id }) => id === models.defaultModelId) ||
      (imageSupport !== undefined && !isImageSupportMap(imageSupport))
    ) {
      throw invalidCatalogError()
    }
    return {
      version: Number(models.version),
      defaultModelId: models.defaultModelId,
      data,
      imageSupport: imageSupport ?? bundledImageSupport(data),
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidCatalogError()
    throw error
  }
}
