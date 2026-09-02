/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type {
  ManagedModel,
  ManagedModelInput,
  ManagedModels,
  ManagedModelTransport,
} from '../../../shared/managed-models.ts'
import { backendHeaders, isSecureCloudUrl } from '../auth/config.ts'
import { abortable, settleBestEffort } from '../lib/abort.ts'
import { isNonblankString, isRecord, uuidPattern } from '../lib/json.ts'
import { providerRuntimeError } from './types.ts'
import type { AccountFetch, ManagedCatalogLoader, ProviderRuntimeError } from './types.ts'

type CatalogError = Error & ProviderRuntimeError
type CatalogErrorCode = Extract<
  ProviderRuntimeError['code'],
  'config-invalid' | 'config-version-unsupported' | 'network' | 'transport-unsupported'
>

const catalogRequestTimeoutMs = 5_000

/** Creates one stable provider-runtime error for catalog operations. */
const createCatalogError = (
  code: CatalogErrorCode,
  message: string,
): CatalogError => providerRuntimeError(code, message)

/** Creates the single error used for malformed schema-v1 content. */
const invalidCatalogError = (): CatalogError =>
  createCatalogError('config-invalid', 'Managed model catalog response is invalid')

/** Parses a required, nonblank catalog string. */
const parseCatalogString = (value: unknown): string => {
  if (isNonblankString(value)) return value
  throw invalidCatalogError()
}

/** Parses a canonical lowercase UUID used for stable catalog identity. */
const parseUuid = (value: unknown): string => {
  const uuid = parseCatalogString(value)
  if (uuidPattern.test(uuid)) return uuid
  throw invalidCatalogError()
}

/** Parses a positive safe integer used by versions and context windows. */
const parsePositiveInteger = (value: unknown): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw invalidCatalogError()
}

/** Parses one required catalog boolean. */
const parseBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  throw invalidCatalogError()
}

/** Parses the nonempty, duplicate-free schema-v1 input capability list. */
const parseInputs = (value: unknown): ManagedModelInput[] => {
  if (!Array.isArray(value) || value.length === 0) throw invalidCatalogError()

  const inputs = value.map((input): ManagedModelInput => {
    if (input === 'text' || input === 'image') return input
    throw invalidCatalogError()
  })
  if (new Set(inputs).size !== inputs.length) throw invalidCatalogError()
  return inputs
}

/** Parses a known schema-v1 transport without adding model-specific branches. */
const parseTransport = (value: unknown): ManagedModelTransport => {
  if (value === 'direct' || value === 'confidential') return value
  if (typeof value === 'string') {
    throw createCatalogError('transport-unsupported', 'Managed model catalog contains an unsupported transport')
  }
  throw invalidCatalogError()
}

/** Reconstructs only the known schema-v1 capability fields. */
const parseCapabilities = (value: unknown): ManagedModel['capabilities'] => {
  if (!isRecord(value)) throw invalidCatalogError()
  return {
    input: parseInputs(value.input),
    tools: parseBoolean(value.tools),
    parallelToolCalls: parseBoolean(value.parallelToolCalls),
    reasoning: parseBoolean(value.reasoning),
    contextWindow: parsePositiveInteger(value.contextWindow),
  }
}

/** Reconstructs only the known schema-v1 default fields. */
const parseDefaults = (value: unknown): ManagedModel['defaults'] => {
  if (!isRecord(value)) throw invalidCatalogError()
  return { startWithReasoning: parseBoolean(value.startWithReasoning) }
}

/** Reconstructs one schema-v1 model while dropping every additive field. */
const parseManagedModel = (value: unknown): ManagedModel => {
  if (!isRecord(value)) throw invalidCatalogError()
  return {
    id: parseUuid(value.id),
    model: parseCatalogString(value.model),
    name: parseCatalogString(value.name),
    description: parseCatalogString(value.description),
    vendor: parseCatalogString(value.vendor),
    transport: parseTransport(value.transport),
    capabilities: parseCapabilities(value.capabilities),
    defaults: parseDefaults(value.defaults),
  }
}

/** Validates catalog identity/default invariants without changing display order. */
const validateModels = (models: ManagedModel[], defaultModelId: string): void => {
  const selectors = new Set<string>()
  for (const model of models) {
    if (selectors.has(model.id) || selectors.has(model.model)) throw invalidCatalogError()
    selectors.add(model.id)
    selectors.add(model.model)
  }
  if (!models.some(({ id }) => id === defaultModelId)) throw invalidCatalogError()
}

/** Reconstructs the supported managed-model catalog from untrusted JSON. */
const parseManagedModels = (value: unknown): ManagedModels => {
  if (!isRecord(value)) throw invalidCatalogError()
  if (
    typeof value.schemaVersion !== 'number' ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion <= 0
  ) {
    throw invalidCatalogError()
  }
  if (value.schemaVersion > 1) {
    throw createCatalogError('config-version-unsupported', 'Managed model catalog schema version is not supported')
  }
  if (!Array.isArray(value.models)) throw invalidCatalogError()

  const version = parsePositiveInteger(value.version)
  const defaultModelId = parseUuid(value.defaultModelId)
  const models = value.models.map(parseManagedModel)
  validateModels(models, defaultModelId)

  return {
    schemaVersion: 1,
    version,
    defaultModelId,
    models,
  }
}

/** Extracts the additive public catalog field from the broader config response. */
const parseConfigResponse = (value: unknown): ManagedModels => {
  if (!isRecord(value)) throw invalidCatalogError()
  return parseManagedModels(value.managedModels)
}

/** Builds the fixed public config URL after enforcing the secure-origin policy. */
const catalogUrl = (backendUrl: string): string => {
  if (!URL.canParse(backendUrl)) {
    throw createCatalogError('config-invalid', 'Managed model catalog backend URL is invalid or insecure')
  }
  const parsedUrl = new URL(backendUrl)

  if (parsedUrl.username !== '' || parsedUrl.password !== '' || !isSecureCloudUrl(parsedUrl.href)) {
    throw createCatalogError('config-invalid', 'Managed model catalog backend URL is invalid or insecure')
  }

  parsedUrl.search = ''
  parsedUrl.hash = ''
  parsedUrl.pathname = `${parsedUrl.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/config`
  return parsedUrl.href
}

/** Issues the bodyless public catalog request and normalizes transport failures. */
const requestCatalog = async (url: string, signal: AbortSignal, fetchFn?: AccountFetch): Promise<Response> => {
  const init = {
    method: 'GET',
    headers: backendHeaders({ accept: 'application/json' }),
    redirect: 'error',
    signal,
  } as const satisfies RequestInit
  try {
    return await abortable(fetchFn ? fetchFn(url, init) : fetch(url, init), signal)
  } catch {
    throw createCatalogError('network', 'Unable to fetch the managed model catalog')
  }
}

/** Reads a successful response body while normalizing stream failures. */
const readCatalogBody = async (response: Response): Promise<string> => {
  try {
    return await response.text()
  } catch {
    throw createCatalogError('network', 'Unable to fetch the managed model catalog')
  }
}

/** Parses JSON and preserves structured catalog validation failures. */
const parseCatalogBody = (body: string): ManagedModels => {
  try {
    const value: unknown = JSON.parse(body)
    return parseConfigResponse(value)
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidCatalogError()
    throw error
  }
}

/** Fetches, validates, and sanitizes the public managed-model catalog. */
export const fetchManagedCatalog: ManagedCatalogLoader = async (backendUrl, fetchFn, timeoutMs) => {
  const signal = AbortSignal.timeout(timeoutMs ?? catalogRequestTimeoutMs)
  const response = await requestCatalog(catalogUrl(backendUrl), signal, fetchFn)
  if (!response.ok) {
    const body = response.body
    if (body) void settleBestEffort(body.cancel())
    throw createCatalogError('network', `Managed model catalog request failed with HTTP ${response.status}`)
  }
  return parseCatalogBody(await readCatalogBody(response))
}
