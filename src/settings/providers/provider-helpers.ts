/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  MODEL_PROVIDER_ORDER,
  SEARCH_PROVIDER_ORDER,
  getProviderDefinition,
  type ProviderCapability,
  type ProviderType,
} from '@shared/providers'
import type { Provider } from '@/dal'
import type { CatalogModel } from '@/lib/providers/validate'

/**
 * Ordered list of catalog provider types available to connect: model providers
 * first (spec order), then search providers, de-duplicated. v1 UI allows one
 * connection per type, so already-connected types are filtered out (spec.md §6).
 */
export const buildConnectTargets = (connectedTypes: ReadonlySet<ProviderType>): ProviderType[] => {
  const ordered = [...MODEL_PROVIDER_ORDER, ...SEARCH_PROVIDER_ORDER]
  const seen = new Set<ProviderType>()
  return ordered.filter((type) => {
    if (seen.has(type) || connectedTypes.has(type)) {
      return false
    }
    seen.add(type)
    return true
  })
}

/** Human-readable display label for a connected provider (account label → catalog name). */
export const providerDisplayLabel = (provider: Provider): string =>
  provider.label?.trim() || getProviderDefinition(provider.type as ProviderType).name

/** Capabilities the user has turned ON for a connection (falls back to the catalog set). */
export const providerEnabledCapabilities = (provider: Provider): ProviderCapability[] =>
  provider.enabledCapabilities ?? getProviderDefinition(provider.type as ProviderType).capabilities

/** Case-insensitive filter over a provider's live model catalog (by name or id). */
export const filterCatalogModels = (models: CatalogModel[], query: string): CatalogModel[] => {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) {
    return models
  }
  return models.filter(
    (model) => model.id.toLowerCase().includes(trimmed) || (model.name?.toLowerCase().includes(trimmed) ?? false),
  )
}
